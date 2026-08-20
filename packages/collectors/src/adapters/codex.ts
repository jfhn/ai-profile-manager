import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CollectResult, ProviderIdentity, UsageWindow } from '@apm/shared';
import type { CollectContext, ProviderAdapter } from '../adapter.js';
import { readJsonSync, readTailBounded, statOrNull, walkFilesBounded } from '../bounded.js';
import { fetchJson, refreshOnce } from '../oauth.js';
import {
  failureKind,
  hasFutureReset,
  isRecord,
  jwtClaims,
  makeQuotaWindow,
  readString,
  safeReason,
} from '../normalize.js';
import {
  readUsageCache,
  writeUsageCache,
  writeUsageError,
  type UsageCache,
} from '../usage-cache.js';

const CODEX_STALE_MS = 24 * 60 * 60 * 1000;
const CODEX_SCAN_AGE_MS = 21 * 24 * 60 * 60 * 1000;
const SHOW_CODEX_FIVE_HOUR = false; // Temporary rollout switch; re-enabling is a one-line change.
const USAGE_TTL_MS = 5 * 60 * 1000;
const USAGE_COOLDOWN_MS = 5 * 60 * 1000;
const CREDENTIAL_SKEW_MS = 60 * 1000;
// Account usage endpoint for ChatGPT-plan Codex accounts. The Codex CLI's
// backend client (openai/codex codex-rs/backend-client/src/client/
// rate_limit_resets.rs) builds `<base>/wham/usage` for the chatgpt.com
// backend-api base URL, sending `Authorization: Bearer <access_token>` and
// `ChatGPT-Account-Id` headers; the CLI-hosted variant of the same route is
// `/api/codex/usage`. Both serve the rate-limit payload normalized below.
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
// OAuth refresh endpoint and the Codex CLI's public client id, mirrored from
// openai/codex codex-rs/login/src/auth/manager.rs (REFRESH_TOKEN_URL and
// CLIENT_ID). Current codex-rs omits `scope`; older releases sent it and the
// endpoint accepts both, so it is kept for compatibility with those tokens.
const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

interface LatestRateLimits {
  timestampMs: number;
  timestamp: string;
  rateLimits: Record<string, unknown>;
}

interface CodexTokens {
  accessToken: string;
  refreshToken: string | null;
  accountId: string | null;
}

export const codexAdapter: ProviderAdapter = {
  provider: 'codex',
  displayName: 'Codex',
  capabilities: {
    usage: true,
    usageSources: ['local-files', 'oauth-api'],
    identity: true,
    windows: ['weekly'],
    notes:
      'Usage prefers the ChatGPT Codex usage endpoint with bounded session rate_limit events as fallback; the five-hour limit is temporarily hidden during OpenAI rollout.',
  },
  hasCredentials: (home) => isRecord(readJsonSync(path.join(home, 'auth.json'))),
  detectIdentity: (home) => codexIdentity(readJsonSync(path.join(home, 'auth.json'))),
  collectUsage: async (ctx) => collectCodexUsage(ctx),
  env: (home) => ({ session: { CODEX_HOME: home }, appOnly: null }),
  loginCommand: (home) => `CODEX_HOME=${home} codex login`,
  loginArgv: () => ['codex', 'login'],
  defaultHome: () => path.join(os.homedir(), '.codex'),
};

async function collectCodexUsage(ctx: CollectContext): Promise<CollectResult> {
  const nowMs = ctx.now ?? Date.now();
  try {
    const local = await collectLocalCodexUsage(ctx, nowMs);
    if (!ctx.allowNetwork) return local;

    const usageFile = path.join(ctx.cacheDir, 'codex-usage.json');
    const usageCache = await readUsageCache(usageFile, nowMs);
    const cached = usableUsagePayload(
      usageCache.usage,
      usageCache.updatedAt,
      'Codex usage endpoint cache',
      'cache',
      nowMs,
    );
    // A user-initiated refresh means "check again now": it skips the fresh
    // cache and the error cooldown alike.
    const forceFetch = ctx.force === true;
    if (!forceFetch && cached && usageCache.ageMs <= USAGE_TTL_MS) return cached;
    if (
      !forceFetch &&
      usageCache.errorAgeMs <= USAGE_COOLDOWN_MS &&
      !(await credentialsChangedSince(ctx.home, usageCache.errorAt, nowMs))
    ) {
      return cooldownFallback(local, usageCache);
    }

    const fetched = await fetchCodexUsage(ctx, nowMs);
    const live = usableUsagePayload(
      fetched.usage,
      new Date(nowMs).toISOString(),
      'Codex usage endpoint',
      'live',
      nowMs,
    );
    if (live) {
      await writeUsageCache(usageFile, {
        updatedAt: new Date(nowMs).toISOString(),
        usage: fetched.usage,
      });
      return live;
    }
    // A 200 we cannot read is a failure, not live data: caching it would serve
    // an empty card for the whole TTL. A genuine zero-usage response still
    // parses into windows, so it does not land here.
    const reason =
      fetched.reason ??
      (fetched.usage
        ? 'Codex usage endpoint returned no recognizable rate limits'
        : 'Codex usage endpoint unavailable');
    await writeUsageError(usageFile, usageCache, reason, nowMs);
    const kind = failureKind(reason);
    // Prefer whichever fallback still carries numbers, so a failed refresh
    // never blanks usage the user can already see. An auth failure is the
    // exception: the cached endpoint numbers belong to a session the endpoint
    // just rejected, so only the local session data may show.
    const cachedFallback =
      kind === 'auth'
        ? null
        : usableUsagePayload(
            usageCache.usage,
            usageCache.updatedAt,
            'Codex usage endpoint cache',
            'stale-cache',
            nowMs,
          );
    if (cachedFallback) {
      return {
        ...cachedFallback,
        stale: true,
        staleReason: reason,
        failureKind: kind,
        error: safeReason(reason),
      };
    }
    if (local.windows.length) {
      return {
        ...local,
        cacheStatus: 'stale-cache',
        stale: true,
        staleReason: reason,
        failureKind: kind,
        error: safeReason(reason),
      };
    }
    return {
      ...local,
      cacheStatus: 'error',
      stale: true,
      staleReason: reason,
      failureKind: kind,
      error: safeReason(reason),
    };
  } catch (error) {
    return failed(safeReason(error instanceof Error ? error.message : error));
  }
}

async function collectLocalCodexUsage(ctx: CollectContext, nowMs: number): Promise<CollectResult> {
  const files = await walkFilesBounded(path.join(ctx.home, 'sessions'), {
    accept: (name) => name.endsWith('.jsonl'),
    newestFirst: true,
    maxFiles: 512,
  });
  const entries = await Promise.all(
    files.map(async (file) => ({ file, stat: await statOrNull(file) })),
  );
  const recent = entries
    .filter((entry) => entry.stat && Number(entry.stat.mtimeMs) >= nowMs - CODEX_SCAN_AGE_MS)
    .sort((a, b) => Number(b.stat?.mtimeMs ?? 0) - Number(a.stat?.mtimeMs ?? 0))
    .slice(0, 64);
  let latest: LatestRateLimits | null = null;
  let readFailed = false;
  for (const { file } of recent) {
    const tail = await readTailBounded(file, 256 * 1024);
    if (!tail) {
      readFailed = true;
      continue;
    }
    const candidate = latestCodexRateLimitsFromJsonl(tail.text);
    if (candidate && (!latest || candidate.timestampMs > latest.timestampMs)) {
      latest = candidate;
    }
  }
  if (!latest) {
    if (readFailed) {
      return failed('Unable to read Codex session rate-limit data');
    }
    return unavailable();
  }
  const windows = codexWindows(latest.rateLimits, nowMs);
  if (!windows.length) {
    return unavailable();
  }
  const stale = nowMs - latest.timestampMs > CODEX_STALE_MS && !hasFutureReset(windows, nowMs);
  return {
    windows,
    source: 'codex session rate_limits',
    cacheStatus: stale ? 'stale-cache' : 'live',
    dataUpdatedAt: latest.timestamp,
    stale,
    staleReason: stale
      ? 'Codex quota data is older than 24 hours and has no active reset window'
      : null,
    failureKind: null,
    error: null,
    planType: readString(latest.rateLimits.plan_type),
    retryAfterSeconds: null,
  };
}

export function latestCodexRateLimitsFromJsonl(text: string | null): LatestRateLimits | null {
  let latest: LatestRateLimits | null = null;
  if (!text) return null;
  for (const line of text.split('\n')) {
    if (!line.includes('"rate_limits"')) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      const record = isRecord(parsed) ? parsed : null;
      const payload = isRecord(record?.payload) ? record.payload : null;
      const rateLimits = isRecord(payload?.rate_limits) ? payload.rate_limits : null;
      if (!rateLimits || (rateLimits.limit_id && rateLimits.limit_id !== 'codex')) continue;
      const timestampMs = Date.parse(readString(record?.timestamp) ?? '');
      if (!Number.isFinite(timestampMs) || (latest && timestampMs <= latest.timestampMs)) continue;
      latest = { timestampMs, timestamp: new Date(timestampMs).toISOString(), rateLimits };
    } catch {
      // A bounded trailing read can begin in the middle of a JSONL record.
    }
  }
  return latest;
}

/**
 * Build usage windows from a `primary`/`secondary` rate-limit pair. Session
 * JSONL events and the usage endpoint share this shape, so both sources feed
 * the same classification, dedupe, and rollout filtering.
 */
function codexWindows(rateLimits: Record<string, unknown>, nowMs: number): UsageWindow[] {
  // Newer Codex builds put the weekly limit in `primary` (window_minutes
  // 10080) with `secondary: null`, so windows are classified by their
  // window_minutes, falling back to the historical positional meaning.
  const primary = makeQuotaWindow(
    ...classifyCodexWindow(rateLimits.primary, 'five_hour', '5h'),
    rateLimits.primary,
    nowMs,
  );
  const secondary = makeQuotaWindow(
    ...classifyCodexWindow(rateLimits.secondary, 'weekly', '7d'),
    rateLimits.secondary,
    nowMs,
  );
  const seen = new Set<string>();
  return [primary, secondary].filter((window): window is UsageWindow => {
    if (!window || seen.has(window.id)) return false;
    if (!SHOW_CODEX_FIVE_HOUR && window.id === 'five_hour') return false;
    seen.add(window.id);
    return true;
  });
}

/** Window identity from window_minutes; positional fallback when absent. */
function classifyCodexWindow(
  input: unknown,
  fallbackId: string,
  fallbackLabel: string,
): [string, string] {
  const minutes = isRecord(input) ? Number(input.window_minutes) : NaN;
  if (!Number.isFinite(minutes) || minutes <= 0) return [fallbackId, fallbackLabel];
  if (minutes >= 40_000) return ['monthly', '30d'];
  if (minutes >= 9_000) return ['weekly', '7d'];
  return ['five_hour', '5h'];
}

/**
 * Normalize a usage-endpoint payload to the session-event rate-limit shape.
 *
 * The current wham/usage response nests windows as `rate_limit.primary_window`
 * with `limit_window_seconds` and a unix-seconds `reset_at`; the legacy
 * codex/usage response (and every session JSONL event) already carries
 * `rate_limits.primary` with `window_minutes`. Both collapse to the latter so
 * codexWindows stays the single window-building path.
 */
function usageRateLimits(data: unknown): Record<string, unknown> | null {
  if (!isRecord(data)) return null;
  const legacy = isRecord(data.rate_limits) ? data.rate_limits : null;
  if (legacy) return legacy.limit_id && legacy.limit_id !== 'codex' ? null : legacy;
  const current = isRecord(data.rate_limit) ? data.rate_limit : null;
  if (!current) return null;
  return {
    primary: whamWindow(current.primary_window),
    secondary: whamWindow(current.secondary_window),
  };
}

function whamWindow(input: unknown): Record<string, unknown> | null {
  if (!isRecord(input)) return null;
  const seconds = Number(input.limit_window_seconds);
  return {
    ...input,
    window_minutes: Number.isFinite(seconds) && seconds > 0 ? seconds / 60 : input.window_minutes,
  };
}

/**
 * Parse a usage-endpoint payload, or null when it yields no window at all.
 *
 * Callers use this instead of a truthiness check on the raw payload: an
 * unexpected body shape is truthy but carries nothing to show, and treating it
 * as data produces an empty card that claims to be live or cached. A response
 * that genuinely reports zero usage still parses into a window, so it is not
 * mistaken for an unreadable one.
 */
function usableUsagePayload(
  data: unknown,
  updatedAt: string | null,
  source: string,
  cacheStatus: CollectResult['cacheStatus'],
  nowMs: number,
): CollectResult | null {
  const rateLimits = usageRateLimits(data);
  if (!rateLimits) return null;
  const windows = codexWindows(rateLimits, nowMs);
  if (!windows.length) return null;
  const updatedMs = Date.parse(updatedAt ?? '');
  const stale =
    Number.isFinite(updatedMs) &&
    nowMs - updatedMs > CODEX_STALE_MS &&
    !hasFutureReset(windows, nowMs);
  return {
    windows,
    source,
    cacheStatus: stale ? 'stale-cache' : cacheStatus,
    dataUpdatedAt: updatedAt,
    stale,
    staleReason: stale
      ? `${source} data is older than 24 hours and has no active reset window`
      : null,
    failureKind: null,
    error: null,
    planType:
      readString(isRecord(data) ? data.plan_type : null) ?? readString(rateLimits.plan_type),
    retryAfterSeconds: null,
  };
}

/**
 * True when the profile logged in (or refreshed its token) after the recorded
 * error, which makes the cached failure obsolete and worth retrying at once.
 *
 * A future-dated mtime is ignored: clock skew or a restored backup would
 * otherwise satisfy the comparison on every run and turn the cooldown off
 * permanently. The tolerance covers ordinary skew between the writer's clock
 * and ours without opening that loop.
 */
async function credentialsChangedSince(
  home: string,
  errorAt: string | null,
  nowMs: number,
): Promise<boolean> {
  const errorMs = Date.parse(errorAt ?? '');
  if (!Number.isFinite(errorMs)) return false;
  const stat = await statOrNull(path.join(home, 'auth.json'));
  const mtimeMs = Number(stat?.mtimeMs ?? NaN);
  if (!Number.isFinite(mtimeMs)) return false;
  return mtimeMs > errorMs && mtimeMs <= nowMs + CREDENTIAL_SKEW_MS;
}

/** During the error cooldown the local session data keeps showing, decorated
 * with the recorded failure so a blank card never replaces usable numbers. */
function cooldownFallback(local: CollectResult, cache: UsageCache): CollectResult {
  const reason = `${cache.errorReason ?? 'Codex usage endpoint is cooling down'}; retrying after short cooldown`;
  return {
    ...local,
    cacheStatus: 'cooldown',
    stale: true,
    staleReason: reason,
    failureKind: failureKind(cache.errorReason),
    retryAfterSeconds: Math.max(0, Math.ceil((USAGE_COOLDOWN_MS - cache.errorAgeMs) / 1000)),
  };
}

async function fetchCodexUsage(
  ctx: CollectContext,
  nowMs: number,
): Promise<{ usage: unknown | null; reason: string | null }> {
  const authFile = path.join(ctx.home, 'auth.json');
  const credentials = codexTokens(readJsonSync(authFile));
  if (!credentials)
    return { usage: null, reason: 'Codex credentials are missing; run codex login' };
  const first = await usageRequest(ctx, credentials);
  if (first.status !== 401) return { usage: first.usage, reason: first.reason };
  if (!credentials.refreshToken)
    return { usage: null, reason: 'Codex usage endpoint rejected credentials; run codex login' };
  const refreshed = await refreshOnce(refreshInFlight, ctx.home, () =>
    requestTokenRefresh(ctx, authFile, credentials, nowMs),
  );
  if (!refreshed.tokens) return { usage: null, reason: refreshed.reason };
  const retry = await usageRequest(ctx, refreshed.tokens);
  return retry.status === 401
    ? { usage: null, reason: 'Codex usage endpoint rejected credentials; run codex login' }
    : { usage: retry.usage, reason: retry.reason };
}

async function usageRequest(
  ctx: CollectContext,
  tokens: CodexTokens,
): Promise<{ status: number | null; usage: unknown | null; reason: string | null }> {
  const outcome = await fetchJson(ctx.fetchImpl, CODEX_USAGE_URL, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${tokens.accessToken}`,
      ...(tokens.accountId ? { 'chatgpt-account-id': tokens.accountId } : {}),
    },
  });
  switch (outcome.kind) {
    case 'ok':
      return { status: outcome.status, usage: outcome.body, reason: null };
    case 'http-error':
      return {
        status: outcome.status,
        usage: null,
        reason:
          outcome.status === 401 || outcome.status === 403
            ? 'Codex usage endpoint rejected credentials; run codex login'
            : `Codex usage endpoint returned HTTP ${outcome.status}`,
      };
    case 'timeout':
      return { status: null, usage: null, reason: safeReason('Codex usage endpoint timed out') };
    case 'failed':
      return {
        status: null,
        usage: null,
        reason: safeReason(outcome.error instanceof Error ? outcome.error.message : outcome.error),
      };
  }
}

interface RefreshOutcome {
  tokens: CodexTokens | null;
  reason: string | null;
}

const refreshInFlight = new Map<string, Promise<RefreshOutcome>>();

async function requestTokenRefresh(
  ctx: CollectContext,
  authFile: string,
  credentials: CodexTokens,
  nowMs: number,
): Promise<RefreshOutcome> {
  const rejected: RefreshOutcome = {
    tokens: null,
    reason: 'Codex token refresh was rejected; run codex login',
  };
  const outcome = await fetchJson(ctx.fetchImpl, CODEX_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CODEX_OAUTH_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: credentials.refreshToken,
      scope: 'openid profile email',
    }),
  });
  switch (outcome.kind) {
    case 'ok': {
      const record = isRecord(outcome.body) ? outcome.body : null;
      const accessToken = readString(record?.access_token);
      if (!accessToken) return rejected;
      return persistRotatedTokens(
        authFile,
        credentials,
        {
          accessToken,
          refreshToken: readString(record?.refresh_token),
          idToken: readString(record?.id_token),
        },
        nowMs,
      );
    }
    case 'http-error':
      return rejected;
    case 'timeout':
      return { tokens: null, reason: safeReason('Codex token refresh timed out') };
    case 'failed':
      return {
        tokens: null,
        reason: safeReason(outcome.error instanceof Error ? outcome.error.message : outcome.error),
      };
  }
}

/**
 * Write rotated tokens back to auth.json the way the Codex CLI would: only the
 * rotated token fields plus `last_refresh` change, every other key survives,
 * and the replace is atomic (same-directory temp file, mode 0600, rename).
 *
 * The file is re-read immediately before writing. When its tokens no longer
 * match the ones this refresh started from, a live CLI refreshed first; its
 * rotation is newer, so the write is aborted and the on-disk tokens are used
 * instead of clobbering them with an already-superseded pair.
 */
async function persistRotatedTokens(
  authFile: string,
  credentials: CodexTokens,
  rotated: { accessToken: string; refreshToken: string | null; idToken: string | null },
  nowMs: number,
): Promise<RefreshOutcome> {
  const current = readJsonSync(authFile);
  const record = isRecord(current) ? current : null;
  const tokens = record && isRecord(record.tokens) ? record.tokens : null;
  if (record && tokens) {
    const diskAccess = readString(tokens.access_token);
    const diskRefresh = readString(tokens.refresh_token);
    if (diskAccess !== credentials.accessToken || diskRefresh !== credentials.refreshToken) {
      const newer = codexTokens(record);
      return newer
        ? { tokens: newer, reason: null }
        : { tokens: null, reason: 'Codex credentials changed during refresh; run codex login' };
    }
    const updated = {
      ...record,
      tokens: {
        ...tokens,
        access_token: rotated.accessToken,
        refresh_token: rotated.refreshToken ?? credentials.refreshToken,
        ...(rotated.idToken ? { id_token: rotated.idToken } : {}),
      },
      last_refresh: new Date(nowMs).toISOString(),
    };
    await writeAuthAtomic(authFile, updated);
  }
  // A vanished or reshaped auth.json is left untouched; the rotated tokens
  // still serve this collection's retry.
  return {
    tokens: {
      accessToken: rotated.accessToken,
      refreshToken: rotated.refreshToken ?? credentials.refreshToken,
      accountId: credentials.accountId,
    },
    reason: null,
  };
}

async function writeAuthAtomic(file: string, value: unknown): Promise<void> {
  const temp = path.join(
    path.dirname(file),
    `.auth.json.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  try {
    await fsp.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await fsp.chmod(temp, 0o600);
    await fsp.rename(temp, file);
  } catch {
    // Persisting is best-effort: the in-memory tokens still serve this run.
    await fsp.rm(temp, { force: true }).catch(() => undefined);
  }
}

function unavailable(): CollectResult {
  return {
    windows: [],
    source: 'codex session rate_limits',
    cacheStatus: 'live',
    dataUpdatedAt: null,
    stale: false,
    staleReason: 'Codex rate limits appear after Codex records a token_count event',
    failureKind: null,
    error: null,
    planType: null,
    retryAfterSeconds: null,
  };
}

function failed(reason: string): CollectResult {
  return {
    windows: [],
    source: 'codex session rate_limits',
    cacheStatus: 'error',
    dataUpdatedAt: null,
    stale: true,
    staleReason: reason,
    failureKind: 'error',
    error: safeReason(reason),
    planType: null,
    retryAfterSeconds: null,
  };
}

function codexTokens(value: unknown): CodexTokens | null {
  if (!isRecord(value)) return null;
  const tokens = isRecord(value.tokens) ? value.tokens : null;
  const accessToken = readString(tokens?.access_token);
  if (!accessToken) return null;
  return {
    accessToken,
    refreshToken: readString(tokens?.refresh_token),
    accountId: readString(tokens?.account_id) ?? accountIdFromJwt(readString(tokens?.id_token)),
  };
}

function accountIdFromJwt(token: string | null): string | null {
  const claims = jwtClaims(token);
  const auth =
    claims && isRecord(claims['https://api.openai.com/auth'])
      ? claims['https://api.openai.com/auth']
      : null;
  return readString(auth?.chatgpt_account_id);
}

function codexIdentity(value: unknown): ProviderIdentity | null {
  if (!isRecord(value)) return null;
  const tokens = isRecord(value.tokens) ? value.tokens : value;
  const claims = jwtClaims(readString(tokens.id_token));
  if (!claims) return null;
  const auth = isRecord(claims['https://api.openai.com/auth'])
    ? claims['https://api.openai.com/auth']
    : claims;
  return {
    account: readString(claims.email) ?? readString(auth.email),
    organization:
      readString(auth.organization) ??
      readString(auth.organization_name) ??
      readString(claims.organization),
    plan:
      readString(auth.chatgpt_plan_type) ??
      readString(claims.chatgpt_plan_type) ??
      readString(auth.plan_type),
  };
}
