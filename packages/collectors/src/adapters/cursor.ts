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

interface CursorTokens {
  accessToken: string;
  refreshToken: string | null;
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
  hasCredentials: (home) => Boolean(tokensForHome(home)?.accessToken),
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
    if (!tokensForHome(ctx.home, ctx.defaultHome)) {
      return failed('Cursor credentials are missing; run cursor-agent login', 'auth');
    }
    const usageFile = path.join(ctx.cacheDir, 'cursor-usage.json');
    const usageCache = await readUsageCache(usageFile, nowMs);
    const cached = usableUsagePayload(
      usageCache.usage,
      usageCache.updatedAt,
      'Cursor usage endpoint cache',
      'cache',
      nowMs,
    );
    if (!ctx.allowNetwork) {
      return (
        cached ??
        failed('Cursor usage endpoint is not fresh and network access is disabled', 'error')
      );
    }
    const forceFetch = ctx.force === true;
    if (!forceFetch && cached && usageCache.ageMs <= USAGE_TTL_MS) return cached;
    if (
      !forceFetch &&
      usageCache.errorAgeMs <= USAGE_COOLDOWN_MS &&
      !(await credentialsChangedSince(ctx.home, usageCache.errorAt, nowMs))
    ) {
      return cooldownFallback(usageCache, nowMs);
    }

    const fetched = await fetchCursorUsage(ctx);
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
): Promise<{ usage: unknown | null; reason: string | null }> {
  const credentials = tokensForHome(ctx.home, ctx.defaultHome);
  if (!credentials) return { usage: null, reason: 'Cursor credentials are missing' };
  const first = await usageRequest(ctx, credentials.accessToken);
  if (first.status !== 401) return { usage: first.usage, reason: first.reason };
  if (!credentials.refreshToken) {
    return { usage: null, reason: 'Cursor usage endpoint rejected credentials' };
  }
  const refreshed = await refreshOnce(refreshInFlight, ctx.home, () =>
    requestTokenRefresh(ctx, credentials),
  );
  if (!refreshed.tokens) return { usage: null, reason: refreshed.reason };
  rememberTokens(ctx.home, refreshed.tokens);
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

interface LiveTokenCache {
  tokens: CursorTokens;
  cachedAtMs: number;
}

/** Rotated tokens stay in memory only, keyed by resolved home. */
const liveTokens = new Map<string, LiveTokenCache>();
const refreshInFlight = new Map<string, Promise<RefreshOutcome>>();

function rememberTokens(home: string, tokens: CursorTokens): void {
  liveTokens.set(path.resolve(home), { tokens, cachedAtMs: Date.now() });
}

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
    planType: planTypeFromUsage(data),
    retryAfterSeconds: null,
  };
}

export function cursorWindows(data: unknown, nowMs: number): UsageWindow[] {
  if (!isRecord(data)) return [];
  const plan = planUsageRecord(data);
  if (!plan) return [];
  const resetAt = normalizeTimestamp(
    plan.billingCycleEnd ?? data.billingCycleEnd ?? plan.resetAt ?? data.resetAt,
  );
  const resetMs = Date.parse(resetAt ?? '');
  const futureReset = Number.isFinite(resetMs) && resetMs > nowMs ? resetAt : null;
  const cursorUsed = clampPercent(
    firstNumber(plan, [
      'cursorModelsPercentUsed',
      'cursor_models_percent_used',
      'cursorModelsUsedPercent',
      'autoPercentUsed',
    ]),
  );
  const otherUsed = clampPercent(
    firstNumber(plan, [
      'otherModelsPercentUsed',
      'other_models_percent_used',
      'otherModelsUsedPercent',
      'apiPercentUsed',
    ]),
  );
  if (cursorUsed === null && otherUsed === null) return [];
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

function planUsageRecord(data: Record<string, unknown>): Record<string, unknown> | null {
  if (isRecord(data.planUsage)) return data.planUsage;
  const individual = isRecord(data.individualUsage) ? data.individualUsage : null;
  if (individual && isRecord(individual.plan)) return individual.plan;
  if (
    data.autoPercentUsed !== undefined ||
    data.apiPercentUsed !== undefined ||
    data.cursorModelsPercentUsed !== undefined
  ) {
    return data;
  }
  return null;
}

function planTypeFromUsage(data: unknown): string | null {
  if (!isRecord(data)) return null;
  const plan = planUsageRecord(data);
  return (
    readString(data.membershipType) ??
    readString(data.planName) ??
    readString(plan?.planName) ??
    readString(plan?.membershipType) ??
    readString(isRecord(data.planInfo) ? data.planInfo.planName : null)
  );
}

function tokensForHome(home: string, defaultHome?: string): CursorTokens | null {
  const key = path.resolve(home);
  const live = liveTokens.get(key);
  if (live) {
    const authMtime = latestAuthMtime(home);
    if (authMtime !== undefined && authMtime > live.cachedAtMs) {
      liveTokens.delete(key);
    } else {
      return live.tokens;
    }
  }
  return tokensFromAuthFiles(home) ?? ideTokensIfDefaultHome(home, defaultHome);
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
    const tokens = tokensFromAuthFile(file);
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

function tokensFromAuthFile(file: string): CursorTokens | null {
  return tokensFromUnknown(readJsonSync(file));
}

function tokensFromUnknown(value: unknown): CursorTokens | null {
  if (!isRecord(value)) return null;
  const nested = [
    value,
    isRecord(value.tokens) ? value.tokens : null,
    isRecord(value.auth) ? value.auth : null,
  ];
  for (const record of nested) {
    if (!record) continue;
    const accessToken =
      readString(record.accessToken) ?? readString(record.access_token) ?? readString(record.token);
    if (accessToken) {
      return {
        accessToken,
        refreshToken: readString(record.refreshToken) ?? readString(record.refresh_token),
      };
    }
  }
  return null;
}

function ideTokensIfDefaultHome(home: string, defaultHome?: string): CursorTokens | null {
  if (!isDefaultHome(home, defaultHome)) return null;
  return tokensFromIdeState(ideStateDbPath());
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

function tokensFromIdeState(dbPath: string): CursorTokens | null {
  const accessToken = readIdeValue(dbPath, 'cursorAuth/accessToken');
  if (!accessToken) return null;
  return {
    accessToken,
    refreshToken: readIdeValue(dbPath, 'cursorAuth/refreshToken'),
  };
}

function readIdeValue(dbPath: string, key: string): string | null {
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(dbPath, { readOnly: true });
    const row: unknown = database.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key);
    if (!isRecord(row)) return null;
    return sqliteText(row.value);
  } catch {
    return null;
  } finally {
    database?.close();
  }
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
  const db = ideStateDbPath();
  const token = readIdeValue(db, 'cursorAuth/accessToken');
  const fromIdeJwt = identityFromJwt(token);
  const email = readIdeValue(db, 'cursorAuth/cachedEmail');
  const plan = readIdeValue(db, 'cursorAuth/stripeMembershipType');
  return mergeIdentity(fromIdeJwt, {
    account: email,
    organization: null,
    plan,
  });
}

function jwtIdentityFromAuthFiles(home: string): ProviderIdentity | null {
  for (const authFile of authFiles(home)) {
    const identity = identityFromUnknown(readJsonSync(authFile));
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

function identityFromUnknown(value: unknown): ProviderIdentity | null {
  const tokens = tokensFromUnknown(value);
  return identityFromJwt(tokens?.accessToken ?? null);
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
