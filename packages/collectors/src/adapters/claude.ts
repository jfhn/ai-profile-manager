import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CollectResult, ProviderIdentity, UsageWindow } from '@apm/shared';
import type { CollectContext, ProviderAdapter } from '../adapter.js';
import { readJsonBounded, statOrNull } from '../bounded.js';
import {
  failureKind,
  firstWindowValue,
  hasFutureReset,
  isRecord,
  makeQuotaWindow,
  normalizeTimestamp,
  rateLimitRoot,
  readString,
  safeReason,
} from '../normalize.js';

const CACHE_FRESH_MS = 10 * 60 * 1000;
const OAUTH_TTL_MS = 5 * 60 * 1000;
const OAUTH_COOLDOWN_MS = 5 * 60 * 1000;
const CREDENTIAL_SKEW_MS = 60 * 1000;
const STALE_MS = 24 * 60 * 60 * 1000;
const FABLE_MAX_BYTES = 16 * 1024;

export const claudeAdapter: ProviderAdapter = {
  provider: 'claude',
  displayName: 'Claude Code',
  capabilities: {
    usage: true,
    usageSources: ['local-files', 'oauth-api'],
    identity: true,
    windows: ['five_hour', 'weekly', 'fable_weekly'],
    notes:
      'OAuth endpoint is undocumented; per-profile usage is only available via OAuth, while global caches are used only for the default home.',
  },
  hasCredentials: (home) =>
    Boolean(oauthCredentials(readJsonSync(path.join(home, '.credentials.json')))?.token),
  detectIdentity: (home) => claudeIdentity(home),
  collectUsage: async (ctx) => collectClaudeUsage(ctx),
  env: (home) => ({ CLAUDE_CONFIG_DIR: home }),
  loginCommand: (home) => `CLAUDE_CONFIG_DIR=${home} claude`,
  defaultHome: () => path.join(os.homedir(), '.claude'),
};

async function collectClaudeUsage(ctx: CollectContext): Promise<CollectResult> {
  const nowMs = ctx.now ?? Date.now();
  try {
    const isDefault =
      path.resolve(ctx.home) === path.resolve(ctx.defaultHome ?? claudeAdapter.defaultHome());
    const globalCacheDir =
      ctx.globalCacheDir ??
      path.join(
        process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'),
        'noctalia-ai-usage',
      );
    const fable = isDefault
      ? await readFable(path.join(globalCacheDir, 'claude-scoped-weekly.json'), nowMs)
      : null;
    const statusline = isDefault
      ? await readRateLimitCache(
          path.join(globalCacheDir, 'claude-rate-limits.json'),
          'claude statusLine rate_limits',
          nowMs,
        )
      : null;
    // A user-initiated refresh means "check again now": it skips the fresh
    // caches and the error cooldown alike. Without network access there is
    // nothing to skip to, so the caches still win there.
    const forceFetch = ctx.force === true && ctx.allowNetwork;
    if (!forceFetch && statusline?.usable && statusline.ageMs <= CACHE_FRESH_MS) {
      return appendFable(statusline.result, fable, nowMs);
    }

    const oauthFile = path.join(ctx.cacheDir, 'claude-oauth-usage.json');
    const oauthCache = await readOauthCache(oauthFile, nowMs);
    const cachedOauth = usableRateLimits(
      oauthCache.usage,
      oauthCache.updatedAt,
      'Claude OAuth usage endpoint cache',
      'cache',
      nowMs,
    );
    if (!forceFetch && cachedOauth && oauthCache.ageMs <= OAUTH_TTL_MS) {
      return appendFable(cachedOauth, fable, nowMs);
    }
    if (
      oauthCache.errorAgeMs <= OAUTH_COOLDOWN_MS &&
      !forceFetch &&
      !(await credentialsChangedSince(ctx.home, oauthCache.errorAt, nowMs))
    ) {
      return appendFable(cooldownResult(oauthCache, nowMs), fable, nowMs);
    }
    if (!ctx.allowNetwork) {
      if (statusline?.usable)
        return appendFable(
          asStale(
            statusline.result,
            'Claude statusline cache is not fresh and network access is disabled',
          ),
          fable,
          nowMs,
        );
      if (cachedOauth)
        return appendFable(
          asStale(cachedOauth, 'Claude OAuth cache is not fresh and network access is disabled'),
          fable,
          nowMs,
        );
      return appendFable(
        emptyPerProfile(
          isDefault
            ? 'No local Claude usage source is fresh and network access is disabled'
            : 'No per-account Claude usage source on disk; run a refresh with network access or check credentials',
        ),
        fable,
        nowMs,
      );
    }

    const fetched = await fetchOauth(ctx, nowMs);
    const live = usableRateLimits(
      fetched.usage,
      new Date(nowMs).toISOString(),
      'Claude OAuth usage endpoint',
      'live',
      nowMs,
    );
    if (live) {
      await writeOauthCache(oauthFile, {
        updatedAt: new Date(nowMs).toISOString(),
        usage: fetched.usage,
      });
      return appendFable(live, fable, nowMs);
    }
    // A 200 we cannot read is a failure, not live data: caching it would serve
    // an empty card for the whole TTL. A genuine zero-usage response still
    // parses into windows, so it does not land here.
    const reason =
      fetched.reason ??
      (fetched.usage
        ? 'Claude OAuth usage endpoint returned no recognizable rate limits'
        : 'Claude OAuth usage endpoint unavailable');
    await writeOauthError(oauthFile, oauthCache, reason, nowMs);
    const kind = failureKind(reason);
    const oauthFallback = usableRateLimits(
      oauthCache.usage,
      oauthCache.updatedAt,
      'Claude OAuth usage endpoint cache',
      'stale-cache',
      nowMs,
    );
    // Prefer whichever fallback still carries numbers, so a failed refresh
    // never blanks usage the user can already see. An auth failure is the
    // exception: those cached OAuth numbers belong to a session the endpoint
    // just rejected, so they stay hidden and only the statusline may show.
    if (oauthFallback && kind !== 'auth') {
      return appendFable(
        {
          ...oauthFallback,
          stale: true,
          staleReason: reason,
          failureKind: kind,
          error: safeReason(reason),
        },
        fable,
        nowMs,
      );
    }
    if (statusline?.usable) {
      return appendFable(
        { ...asStale(statusline.result, reason), failureKind: kind, error: safeReason(reason) },
        fable,
        nowMs,
      );
    }
    if (oauthFallback) {
      // Only reachable for an auth failure: the rejected session's numbers are
      // withheld, but the cache's timestamp still explains what went stale.
      return appendFable(
        {
          ...oauthFallback,
          windows: [],
          source: 'Claude OAuth usage endpoint',
          stale: true,
          staleReason: reason,
          failureKind: kind,
          error: safeReason(reason),
        },
        fable,
        nowMs,
      );
    }
    return appendFable(
      {
        ...emptyPerProfile(
          isDefault
            ? reason
            : `No per-account Claude usage source on disk; run a refresh with network access or check credentials: ${reason}`,
        ),
        cacheStatus: 'error',
        failureKind: kind,
        error: safeReason(reason),
      },
      fable,
      nowMs,
    );
  } catch (error) {
    const reason = safeReason(error instanceof Error ? error.message : error);
    return {
      ...emptyPerProfile(reason),
      cacheStatus: 'error',
      failureKind: failureKind(reason),
      error: reason,
    };
  }
}

async function readRateLimitCache(
  file: string,
  source: string,
  nowMs: number,
): Promise<{ result: CollectResult; usable: boolean; ageMs: number }> {
  const [data, stat] = await Promise.all([readJsonBounded(file), statOrNull(file)]);
  const updatedAt =
    normalizeTimestamp(isRecord(data) ? data.updatedAt : null) ?? stat?.mtime.toISOString() ?? null;
  const result = fromRateLimits(data, updatedAt, source, 'cache', nowMs);
  const updatedMs = Date.parse(updatedAt ?? '');
  return {
    result,
    usable: result.windows.length > 0,
    ageMs: Number.isFinite(updatedMs) ? nowMs - updatedMs : Infinity,
  };
}

function fromRateLimits(
  data: unknown,
  updatedAt: string | null,
  source: string,
  cacheStatus: CollectResult['cacheStatus'],
  nowMs: number,
): CollectResult {
  const root = rateLimitRoot(data);
  const fiveHour = makeQuotaWindow(
    'five_hour',
    '5h',
    firstWindowValue(root, ['five_hour', 'fiveHour', '5_hour', 'five-hour', 'hour_5', 'primary']),
    nowMs,
  );
  const weekly = makeQuotaWindow(
    'weekly',
    '7d',
    firstWindowValue(root, [
      'seven_day',
      'sevenDay',
      'weekly',
      'week',
      '7_day',
      'seven-day',
      'secondary',
    ]),
    nowMs,
  );
  const fable = makeQuotaWindow(
    'fable_weekly',
    'Fable 5 weekly',
    firstWindowValue(root, [
      'seven_day_fable',
      'sevenDayFable',
      'fable_weekly',
      'fableWeekly',
      'seven_day_scoped',
      'scoped_weekly',
      'scopedWeekly',
      'fable',
    ]),
    nowMs,
  );
  const windows = [fiveHour, weekly, fable].filter((window): window is UsageWindow =>
    Boolean(window),
  );
  const updatedMs = Date.parse(updatedAt ?? '');
  const stale =
    Number.isFinite(updatedMs) && nowMs - updatedMs > STALE_MS && !hasFutureReset(windows, nowMs);
  return {
    windows,
    source,
    cacheStatus: stale ? 'stale-cache' : cacheStatus,
    dataUpdatedAt: updatedAt,
    stale,
    staleReason: stale
      ? `${source} data is older than 24 hours and has no active reset window`
      : windows.length
        ? null
        : 'Claude rate limits appear after Claude Code provides statusline input',
    failureKind: null,
    error: null,
    planType: null,
    retryAfterSeconds: null,
  };
}

/**
 * Parse a rate-limit payload, or null when it yields no window at all.
 *
 * Callers use this instead of a truthiness check on the raw payload: an
 * unexpected body shape is truthy but carries nothing to show, and treating it
 * as data produces an empty card that claims to be live or cached. A response
 * that genuinely reports zero usage still parses into a window, so it is not
 * mistaken for an unreadable one.
 */
function usableRateLimits(
  data: unknown,
  updatedAt: string | null,
  source: string,
  cacheStatus: CollectResult['cacheStatus'],
  nowMs: number,
): CollectResult | null {
  if (!data) return null;
  const result = fromRateLimits(data, updatedAt, source, cacheStatus, nowMs);
  return result.windows.length ? result : null;
}

async function readFable(file: string, nowMs: number): Promise<UsageWindow | null> {
  const [data, stat] = await Promise.all([
    readJsonBounded(file, FABLE_MAX_BYTES),
    statOrNull(file),
  ]);
  const mtimeMs = Number(stat?.mtimeMs ?? 0);
  if (
    !isRecord(data) ||
    !isFableModel(data.model) ||
    !Number.isFinite(mtimeMs) ||
    mtimeMs <= 0 ||
    nowMs - mtimeMs > CACHE_FRESH_MS ||
    mtimeMs > nowMs + 5 * 60 * 1000
  )
    return null;
  const percent = data.percent;
  const resetAt = normalizeTimestamp(data.resets_at);
  const resetMs = Date.parse(resetAt ?? '');
  if (
    typeof percent !== 'number' ||
    !Number.isFinite(percent) ||
    percent < 0 ||
    percent > 100 ||
    !Number.isFinite(resetMs) ||
    resetMs <= nowMs
  )
    return null;
  return {
    id: 'fable_weekly',
    label: 'Fable 5 weekly',
    usedPercent: percent,
    remainingPercent: 100 - percent,
    resetAt,
  };
}

function appendFable(
  result: CollectResult,
  fable: UsageWindow | null,
  _nowMs: number,
): CollectResult {
  if (!fable || (result.failureKind === 'auth' && !result.windows.length)) return result;
  // The scoped-weekly cache is a fallback: per-profile OAuth data wins when present.
  if (result.windows.some((window) => window.id === fable.id)) return result;
  const windows = [...result.windows, fable];
  if (result.windows.length)
    return { ...result, windows, source: `${result.source}; Fable scoped weekly cache` };
  return {
    ...result,
    windows,
    source: 'Fable scoped weekly cache',
    cacheStatus: result.cacheStatus === 'error' ? 'cache' : result.cacheStatus,
    stale: false,
    staleReason: null,
    failureKind: null,
    error: null,
  };
}

interface OAuthCache {
  usage: unknown | null;
  updatedAt: string | null;
  ageMs: number;
  errorAt: string | null;
  errorAgeMs: number;
  errorReason: string | null;
}

async function readOauthCache(file: string, nowMs: number): Promise<OAuthCache> {
  const data = await readJsonBounded(file);
  const record = isRecord(data) ? data : null;
  const updatedAt = normalizeTimestamp(record?.updatedAt);
  const errorAt = normalizeTimestamp(record?.lastErrorAt);
  const updatedMs = Date.parse(updatedAt ?? '');
  const errorMs = Date.parse(errorAt ?? '');
  return {
    usage: record?.usage ?? null,
    updatedAt,
    ageMs: Number.isFinite(updatedMs) ? nowMs - updatedMs : Infinity,
    errorAt,
    errorAgeMs: Number.isFinite(errorMs) ? nowMs - errorMs : Infinity,
    errorReason: readString(record?.lastErrorReason),
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
  const stat = await statOrNull(path.join(home, '.credentials.json'));
  const mtimeMs = Number(stat?.mtimeMs ?? NaN);
  if (!Number.isFinite(mtimeMs)) return false;
  return mtimeMs > errorMs && mtimeMs <= nowMs + CREDENTIAL_SKEW_MS;
}

function cooldownResult(cache: OAuthCache, _nowMs: number): CollectResult {
  const reason = `${cache.errorReason ?? 'Claude OAuth usage endpoint is cooling down'}; retrying after short cooldown`;
  return {
    ...emptyPerProfile(reason),
    source: 'Claude OAuth usage endpoint',
    cacheStatus: 'cooldown',
    stale: true,
    failureKind: failureKind(cache.errorReason),
    retryAfterSeconds: Math.max(0, Math.ceil((OAUTH_COOLDOWN_MS - cache.errorAgeMs) / 1000)),
  };
}

async function fetchOauth(
  ctx: CollectContext,
  nowMs: number,
): Promise<{ usage: unknown | null; reason: string | null }> {
  const credentials = oauthCredentials(readJsonSync(path.join(ctx.home, '.credentials.json')));
  if (!credentials?.token)
    return {
      usage: null,
      reason: 'Claude OAuth credentials are missing; run claude auth login or start Claude Code',
    };
  if (credentials.expiresMs !== null && credentials.expiresMs <= nowMs + 30_000)
    return {
      usage: null,
      reason: 'Claude OAuth access token is expired; run claude auth login or start Claude Code',
    };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await (ctx.fetchImpl ?? fetch)('https://api.anthropic.com/api/oauth/usage', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${credentials.token}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: controller.signal,
    });
    if (!response.ok)
      return {
        usage: null,
        reason:
          response.status === 401 || response.status === 403
            ? 'Claude OAuth usage endpoint rejected credentials; run claude auth login or start Claude Code'
            : `Claude OAuth usage endpoint returned HTTP ${response.status}`,
      };
    return { usage: await response.json(), reason: null };
  } catch (error) {
    return {
      usage: null,
      reason: safeReason(
        error instanceof Error && error.name === 'AbortError'
          ? 'Claude OAuth usage endpoint timed out'
          : error instanceof Error
            ? error.message
            : error,
      ),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function writeOauthCache(
  file: string,
  data: { updatedAt: string; usage: unknown },
): Promise<void> {
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await fsp.chmod(file, 0o600);
  } catch {
    // Cache writes are best-effort.
  }
}

async function writeOauthError(
  file: string,
  cache: OAuthCache,
  reason: string,
  nowMs: number,
): Promise<void> {
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(
      file,
      `${JSON.stringify({ updatedAt: cache.updatedAt, usage: cache.usage, lastErrorAt: new Date(nowMs).toISOString(), lastErrorReason: safeReason(reason) }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await fsp.chmod(file, 0o600);
  } catch {
    // Cache writes are best-effort.
  }
}

function emptyPerProfile(reason: string): CollectResult {
  return {
    windows: [],
    source: 'per-account Claude usage source',
    cacheStatus: 'error',
    dataUpdatedAt: null,
    stale: true,
    staleReason: reason,
    failureKind: null,
    error: null,
    planType: null,
    retryAfterSeconds: null,
  };
}

function asStale(result: CollectResult, reason: string): CollectResult {
  return { ...result, cacheStatus: 'stale-cache', stale: true, staleReason: reason };
}

function oauthCredentials(
  value: unknown,
): { token: string; expiresMs: number | null; plan: string | null } | null {
  const oauth = isRecord(value) && isRecord(value.claudeAiOauth) ? value.claudeAiOauth : null;
  const token = readString(oauth?.accessToken);
  if (!token) return null;
  const expiresAt = normalizeTimestamp(oauth?.expiresAt);
  const expiresMs = Date.parse(expiresAt ?? '');
  return {
    token,
    expiresMs: Number.isFinite(expiresMs) ? expiresMs : null,
    plan: readString(oauth?.subscriptionType),
  };
}

function claudeIdentity(home: string): ProviderIdentity | null {
  const config =
    readJsonSync(path.join(home, '.claude.json')) ??
    readJsonSync(path.join(path.dirname(home), '.claude.json'));
  const account = isRecord(config) && isRecord(config.oauthAccount) ? config.oauthAccount : null;
  const creds = oauthCredentials(readJsonSync(path.join(home, '.credentials.json')));
  if (!account && !creds) return null;
  return {
    account: readString(account?.emailAddress),
    organization: readString(account?.organizationName),
    plan: creds?.plan ?? null,
  };
}

function isFableModel(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    ['fable', 'fable 5', 'fable-5', 'claude-fable-5'].includes(value.trim().toLowerCase())
  );
}

function readJsonSync(file: string): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
}
