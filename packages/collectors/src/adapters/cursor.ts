import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CollectResult, ProviderIdentity, UsageWindow } from '@apm/shared';
import type { CollectContext, ProviderAdapter } from '../adapter.js';
import { readJsonSync, statOrNull } from '../bounded.js';
import { fetchJson, refreshOnce } from '../oauth.js';
import {
  clampPercent,
  failureKind,
  firstNumber,
  hasFutureReset,
  isRecord,
  jwtClaims,
  normalizeTimestamp,
  readString,
  safeReason,
} from '../normalize.js';
import {
  readUsageCache,
  writeUsageCache,
  writeUsageError,
  type UsageCache,
} from '../usage-cache.js';

const USAGE_TTL_MS = 5 * 60 * 1000;
const USAGE_COOLDOWN_MS = 5 * 60 * 1000;
const CREDENTIAL_SKEW_MS = 60 * 1000;
const STALE_MS = 24 * 60 * 60 * 1000;
const USAGE_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage';
const REFRESH_URL = 'https://api2.cursor.sh/oauth/token';
/**
 * Public OAuth client id embedded in Cursor clients. Refreshing with it keeps
 * rotated tokens valid for the CLI/IDE that owns the home. Undocumented.
 */
const OAUTH_CLIENT_ID = 'KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB';
const IDE_ACCESS_TOKEN_KEY = 'cursorAuth/accessToken';
const IDE_REFRESH_TOKEN_KEY = 'cursorAuth/refreshToken';
const IDE_EMAIL_KEY = 'cursorAuth/cachedEmail';
const IDE_PLAN_KEY = 'cursorAuth/stripeMembershipType';

interface CursorTokens {
  accessToken: string;
  refreshToken: string | null;
}

/** Which store the tokens came from; a remembered pair is validated against it. */
type TokenSource = 'auth-file' | 'ide-db';

interface HomeTokens {
  tokens: CursorTokens;
  source: TokenSource;
}

interface RefreshOutcome {
  tokens: CursorTokens | null;
  reason: string | null;
}

export const cursorAdapter: ProviderAdapter = {
  provider: 'cursor',
  displayName: 'Cursor',
  capabilities: {
    usage: true,
    usageSources: ['local-files', 'oauth-api'],
    identity: true,
    windows: ['cursor_models', 'other_models'],
    notes:
      'Usage is the undocumented dashboard GetCurrentPeriodUsage RPC; login writes auth.json via AGENT_CLI_CREDENTIAL_STORE=file; the default ~/.cursor home may read the IDE session token from state.vscdb.',
  },
  hasCredentials: (home) => Boolean(tokensForHome(home)?.tokens.accessToken),
  detectIdentity: (home) => cursorIdentity(home),
  collectUsage: async (ctx) => collectCursorUsage(ctx),
  env: (home) => cursorChildEnv(home),
  loginCommand: (home) => {
    const assignments = Object.entries(cursorChildEnv(home))
      .map(([key, value]) => `${key}=${value}`)
      .join(' ');
    return `${assignments} cursor-agent login`;
  },
  loginArgv: () => ['cursor-agent', 'login'],
  defaultHome: () => path.join(os.homedir(), '.cursor'),
};

/**
 * `CURSOR_CONFIG_DIR` isolates `cli-config.json`. The file credential store
 * ignores it and writes `$XDG_CONFIG_HOME/cursor/auth.json` on Linux
 * (`%APPDATA%/Cursor/auth.json` on Windows). Point those roots at the profile
 * home so login tokens land inside it.
 */
function cursorChildEnv(home: string): Record<string, string> {
  if (process.platform === 'win32') {
    return {
      CURSOR_CONFIG_DIR: home,
      AGENT_CLI_CREDENTIAL_STORE: 'file',
      APPDATA: home,
    };
  }
  return {
    CURSOR_CONFIG_DIR: home,
    AGENT_CLI_CREDENTIAL_STORE: 'file',
    XDG_CONFIG_HOME: home,
  };
}

async function collectCursorUsage(ctx: CollectContext): Promise<CollectResult> {
  const nowMs = ctx.now ?? Date.now();
  try {
    const usageFile = path.join(ctx.cacheDir, 'cursor-usage.json');
    const usageCache = await readUsageCache(usageFile, nowMs);
    const cached = usableUsagePayload(
      usageCache.usage,
      usageCache.updatedAt,
      'Cursor usage endpoint cache',
      'cache',
      nowMs,
    );
    // A user-initiated refresh means "check again now": it skips the fresh
    // cache and the error cooldown alike.
    const forceFetch = ctx.force === true;
    if (!forceFetch && cached && usageCache.ageMs <= USAGE_TTL_MS) return cached;

    const credentials = tokensForHome(ctx.home, ctx.defaultHome);
    if (!credentials) {
      return failed('Cursor credentials are missing; run cursor-agent login', 'auth');
    }
    if (!ctx.allowNetwork) {
      return (
        cached ??
        failed('Cursor usage endpoint is not fresh and network access is disabled', 'error')
      );
    }
    if (
      !forceFetch &&
      usageCache.errorAgeMs <= USAGE_COOLDOWN_MS &&
      !(await credentialsChangedSince(ctx.home, usageCache.errorAt, nowMs))
    ) {
      return cooldownFallback(usageCache, nowMs);
    }

    const fetched = await fetchCursorUsage(ctx, credentials);
    const live = usableUsagePayload(
      fetched.usage,
      new Date(nowMs).toISOString(),
      'Cursor usage endpoint',
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
    const reason = fetched.reason ?? 'Cursor usage endpoint returned no recognizable usage windows';
    await writeUsageError(usageFile, usageCache, reason, nowMs);
    const kind = failureKind(reason);
    const cachedFallback =
      kind === 'auth'
        ? null
        : usableUsagePayload(
            usageCache.usage,
            usageCache.updatedAt,
            'Cursor usage endpoint cache',
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
    return failed(reason, kind ?? 'error');
  } catch (error) {
    return failed(safeReason(error instanceof Error ? error.message : error), 'error');
  }
}

async function fetchCursorUsage(
  ctx: CollectContext,
  credentials: HomeTokens,
): Promise<{ usage: unknown | null; reason: string | null }> {
  const first = await usageRequest(ctx, credentials.tokens.accessToken);
  if (first.status !== 401) return { usage: first.usage, reason: first.reason };
  if (!credentials.tokens.refreshToken) {
    return { usage: null, reason: 'Cursor usage endpoint rejected credentials' };
  }
  const refreshed = await refreshOnce(refreshInFlight, ctx.home, () =>
    requestTokenRefresh(ctx, credentials.tokens),
  );
  if (!refreshed.tokens) return { usage: null, reason: refreshed.reason };
  rememberTokens(ctx.home, refreshed.tokens, credentials.source);
  const retry = await usageRequest(ctx, refreshed.tokens.accessToken);
  return retry.status === 401
    ? { usage: null, reason: 'Cursor usage endpoint rejected credentials' }
    : { usage: retry.usage, reason: retry.reason };
}

async function usageRequest(
  ctx: CollectContext,
  accessToken: string,
): Promise<{ status: number | null; usage: unknown | null; reason: string | null }> {
  const outcome = await fetchJson(ctx.fetchImpl, USAGE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
      Authorization: `Bearer ${accessToken}`,
    },
    body: '{}',
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
            ? 'Cursor usage endpoint rejected credentials'
            : `Cursor usage endpoint returned HTTP ${outcome.status}`,
      };
    case 'timeout':
      return { status: null, usage: null, reason: 'Cursor usage endpoint timed out' };
    case 'failed':
      return {
        status: null,
        usage: null,
        reason: safeReason(outcome.error instanceof Error ? outcome.error.message : outcome.error),
      };
  }
}

const refreshInFlight = new Map<string, Promise<RefreshOutcome>>();

async function requestTokenRefresh(
  ctx: CollectContext,
  credentials: CursorTokens,
): Promise<RefreshOutcome> {
  const rejected: RefreshOutcome = { tokens: null, reason: 'Cursor token refresh was rejected' };
  const outcome = await fetchJson(ctx.fetchImpl, REFRESH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: OAUTH_CLIENT_ID,
      refresh_token: credentials.refreshToken,
    }),
  });
  switch (outcome.kind) {
    case 'ok': {
      const record = isRecord(outcome.body) ? outcome.body : null;
      if (record?.shouldLogout === true) return rejected;
      const accessToken = readString(record?.access_token);
      if (!accessToken) return rejected;
      return {
        tokens: {
          accessToken,
          refreshToken: readString(record?.refresh_token) ?? credentials.refreshToken,
        },
        reason: null,
      };
    }
    case 'http-error':
      return rejected;
    case 'timeout':
      return { tokens: null, reason: 'Cursor token refresh timed out' };
    case 'failed':
      return {
        tokens: null,
        reason: safeReason(outcome.error instanceof Error ? outcome.error.message : outcome.error),
      };
  }
}

function usableUsagePayload(
  data: unknown,
  updatedAt: string | null,
  source: string,
  cacheStatus: CollectResult['cacheStatus'],
  nowMs: number,
): CollectResult | null {
  const windows = cursorWindows(data, nowMs);
  if (!windows.length) return null;
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
      : null,
    failureKind: null,
    error: null,
    planType: isRecord(data) ? readString(data.membershipType) : null,
    retryAfterSeconds: null,
  };
}

export function cursorWindows(data: unknown, nowMs: number): UsageWindow[] {
  if (!isRecord(data) || !isRecord(data.planUsage)) return [];
  const plan = data.planUsage;
  const resetAt = normalizeTimestamp(data.billingCycleEnd);
  const resetMs = Date.parse(resetAt ?? '');
  const futureReset = Number.isFinite(resetMs) && resetMs > nowMs ? resetAt : null;
  const cursorUsed = clampPercent(
    firstNumber(plan, ['cursorModelsPercentUsed', 'autoPercentUsed']),
  );
  const otherUsed = clampPercent(firstNumber(plan, ['otherModelsPercentUsed', 'apiPercentUsed']));
  const windows: UsageWindow[] = [];
  if (cursorUsed !== null) {
    windows.push({
      id: 'cursor_models',
      label: 'Cursor Models',
      usedPercent: cursorUsed,
      remainingPercent: clampPercent(100 - cursorUsed),
      resetAt: futureReset,
    });
  }
  if (otherUsed !== null) {
    windows.push({
      id: 'other_models',
      label: 'Other Models',
      usedPercent: otherUsed,
      remainingPercent: clampPercent(100 - otherUsed),
      resetAt: futureReset,
    });
  }
  return windows;
}

interface LiveTokenCache {
  tokens: CursorTokens;
  source: TokenSource;
  cachedAtMs: number;
}

/** Rotated tokens stay in memory only, keyed by resolved home. */
const liveTokens = new Map<string, LiveTokenCache>();

function rememberTokens(home: string, tokens: CursorTokens, source: TokenSource): void {
  liveTokens.set(path.resolve(home), { tokens, source, cachedAtMs: Date.now() });
}

function tokensForHome(home: string, defaultHome?: string): HomeTokens | null {
  const key = path.resolve(home);
  const live = liveTokens.get(key);
  if (live) {
    if (rememberedTokensStillValid(live, home)) {
      return { tokens: live.tokens, source: live.source };
    }
    liveTokens.delete(key);
  }
  const fromFile = tokensFromAuthFiles(home);
  if (fromFile) return { tokens: fromFile, source: 'auth-file' };
  const fromIde = ideTokensIfDefaultHome(home, defaultHome);
  return fromIde ? { tokens: fromIde, source: 'ide-db' } : null;
}

/**
 * Remembered tokens live only as long as the store they were refreshed from is
 * unchanged. A newer store means the CLI or IDE rotated on its own, and a
 * vanished one means the profile logged out — in both cases the remembered pair
 * would outlive the session it belongs to.
 */
function rememberedTokensStillValid(live: LiveTokenCache, home: string): boolean {
  const mtimeMs =
    live.source === 'auth-file'
      ? latestAuthMtime(home)
      : fs.statSync(ideStateDbPath(), { throwIfNoEntry: false })?.mtimeMs;
  return mtimeMs !== undefined && mtimeMs <= live.cachedAtMs;
}

/** Paths the Cursor CLI file store actually uses inside a bound home. */
function authFiles(home: string): string[] {
  return [
    path.join(home, 'auth.json'),
    path.join(home, 'cursor', 'auth.json'),
    path.join(home, 'Cursor', 'auth.json'),
  ];
}

function tokensFromAuthFiles(home: string): CursorTokens | null {
  for (const file of authFiles(home)) {
    const tokens = tokensFromUnknown(readJsonSync(file));
    if (tokens) return tokens;
  }
  return null;
}

function latestAuthMtime(home: string): number | undefined {
  let latest: number | undefined;
  for (const file of authFiles(home)) {
    const mtime = fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs;
    if (mtime !== undefined && (latest === undefined || mtime > latest)) latest = mtime;
  }
  return latest;
}

function tokensFromUnknown(value: unknown): CursorTokens | null {
  if (!isRecord(value)) return null;
  const accessToken = readString(value.accessToken);
  if (!accessToken) return null;
  return { accessToken, refreshToken: readString(value.refreshToken) };
}

function ideTokensIfDefaultHome(home: string, defaultHome?: string): CursorTokens | null {
  if (!isDefaultHome(home, defaultHome)) return null;
  const values = readIdeValues(ideStateDbPath(), [IDE_ACCESS_TOKEN_KEY, IDE_REFRESH_TOKEN_KEY]);
  const accessToken = values.get(IDE_ACCESS_TOKEN_KEY);
  if (!accessToken) return null;
  return { accessToken, refreshToken: values.get(IDE_REFRESH_TOKEN_KEY) ?? null };
}

// The path itself must be the default home. A managed directory that merely
// symlinks at ~/.cursor must not inherit the IDE session.
function isDefaultHome(home: string, defaultHome?: string): boolean {
  return path.resolve(home) === path.resolve(defaultHome ?? cursorAdapter.defaultHome());
}

function ideStateDbPath(): string {
  if (process.platform === 'darwin') {
    return path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'Cursor',
      'User',
      'globalStorage',
      'state.vscdb',
    );
  }
  if (process.platform === 'win32') {
    return path.join(
      process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'),
      'Cursor',
      'User',
      'globalStorage',
      'state.vscdb',
    );
  }
  return path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'),
    'Cursor',
    'User',
    'globalStorage',
    'state.vscdb',
  );
}

/** Every wanted key in one read; a missing or unreadable database yields none. */
function readIdeValues(dbPath: string, keys: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(dbPath, { readOnly: true });
    const rows = database
      .prepare(`SELECT key, value FROM ItemTable WHERE key IN (${keys.map(() => '?').join(', ')})`)
      .all(...keys);
    for (const row of rows) {
      if (!isRecord(row)) continue;
      const key = readString(row.key);
      const value = sqliteText(row.value);
      if (key && value) values.set(key, value);
    }
  } catch {
    // No IDE session to read.
  } finally {
    database?.close();
  }
  return values;
}

function sqliteText(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value instanceof Uint8Array) {
    const text = Buffer.from(value).toString('utf8').trim();
    return text || null;
  }
  return readString(value);
}

function cursorIdentity(home: string): ProviderIdentity | null {
  const hasAuth = authFiles(home).some((file) => fs.existsSync(file));
  if (hasAuth) {
    // CLI file-store session: jwt email if present, else cli-config written
    // by the same login. Do not fill gaps from the IDE database.
    return mergeIdentity(jwtIdentityFromAuthFiles(home), identityFromCliConfig(home));
  }
  if (!isDefaultHome(home)) return null;
  const values = readIdeValues(ideStateDbPath(), [
    IDE_ACCESS_TOKEN_KEY,
    IDE_EMAIL_KEY,
    IDE_PLAN_KEY,
  ]);
  return mergeIdentity(identityFromJwt(values.get(IDE_ACCESS_TOKEN_KEY) ?? null), {
    account: values.get(IDE_EMAIL_KEY) ?? null,
    organization: null,
    plan: values.get(IDE_PLAN_KEY) ?? null,
  });
}

function jwtIdentityFromAuthFiles(home: string): ProviderIdentity | null {
  for (const authFile of authFiles(home)) {
    const tokens = tokensFromUnknown(readJsonSync(authFile));
    const identity = identityFromJwt(tokens?.accessToken ?? null);
    if (identity) return identity;
  }
  return null;
}

function identityFromCliConfig(home: string): ProviderIdentity | null {
  const data = readJsonSync(path.join(home, 'cli-config.json'));
  if (!isRecord(data) || !isRecord(data.authInfo)) return null;
  const info = data.authInfo;
  return mergeIdentity(null, {
    account: readString(info.email),
    organization: readString(info.teamName),
    plan: readString(info.plan) ?? readString(info.membershipType),
  });
}

function mergeIdentity(
  primary: ProviderIdentity | null,
  fallback: ProviderIdentity | null,
): ProviderIdentity | null {
  const identity = {
    account: primary?.account ?? fallback?.account ?? null,
    organization: primary?.organization ?? fallback?.organization ?? null,
    plan: primary?.plan ?? fallback?.plan ?? null,
  };
  if (!identity.account && !identity.organization && !identity.plan) return null;
  return identity;
}

function identityFromJwt(token: string | null): ProviderIdentity | null {
  const claims = jwtClaims(token);
  if (!claims) return null;
  const account = readString(claims.email);
  const plan = readString(claims.plan) ?? readString(claims.membershipType);
  if (!account && !plan) return null;
  return { account, organization: readString(claims.organization), plan };
}

async function credentialsChangedSince(
  home: string,
  errorAt: string | null,
  nowMs: number,
): Promise<boolean> {
  const errorMs = Date.parse(errorAt ?? '');
  if (!Number.isFinite(errorMs)) return false;
  // Only CLI auth files. state.vscdb is rewritten constantly while the IDE is
  // open, so its mtime would disable the error cooldown on every scheduler tick.
  const files = authFiles(home);
  for (const file of files) {
    const stat = await statOrNull(file);
    const mtimeMs = Number(stat?.mtimeMs ?? NaN);
    if (Number.isFinite(mtimeMs) && mtimeMs > errorMs && mtimeMs <= nowMs + CREDENTIAL_SKEW_MS) {
      return true;
    }
  }
  return false;
}

function cooldownFallback(cache: UsageCache, nowMs: number): CollectResult {
  const reason = `${cache.errorReason ?? 'Cursor usage endpoint is cooling down'}; retrying after short cooldown`;
  const cached = usableUsagePayload(
    cache.usage,
    cache.updatedAt,
    'Cursor usage endpoint cache',
    'cooldown',
    nowMs,
  );
  if (cached) {
    return {
      ...cached,
      cacheStatus: 'cooldown',
      stale: true,
      staleReason: reason,
      failureKind: failureKind(cache.errorReason),
      retryAfterSeconds: Math.max(0, Math.ceil((USAGE_COOLDOWN_MS - cache.errorAgeMs) / 1000)),
    };
  }
  return {
    ...failed(reason, failureKind(cache.errorReason) ?? 'error'),
    cacheStatus: 'cooldown',
    retryAfterSeconds: Math.max(0, Math.ceil((USAGE_COOLDOWN_MS - cache.errorAgeMs) / 1000)),
  };
}

function failed(reason: string, kind: NonNullable<CollectResult['failureKind']>): CollectResult {
  return {
    windows: [],
    source: 'Cursor usage endpoint',
    cacheStatus: 'error',
    dataUpdatedAt: null,
    stale: true,
    staleReason: reason,
    failureKind: kind,
    error: safeReason(reason),
    planType: null,
    retryAfterSeconds: null,
  };
}
