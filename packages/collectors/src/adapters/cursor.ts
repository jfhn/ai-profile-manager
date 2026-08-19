import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CollectResult, ProviderIdentity, UsageWindow } from '@apm/shared';
import type { CollectContext, ProviderAdapter } from '../adapter.js';
import { readJsonBounded, statOrNull } from '../bounded.js';
import {
  clampPercent,
  failureKind,
  isRecord,
  normalizeTimestamp,
  readString,
  safeReason,
  toNumber,
} from '../normalize.js';

const USAGE_TTL_MS = 5 * 60 * 1000;
const USAGE_COOLDOWN_MS = 5 * 60 * 1000;
const CREDENTIAL_SKEW_MS = 60 * 1000;
const STALE_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8_000;
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

interface UsageCache {
  usage: unknown | null;
  updatedAt: string | null;
  ageMs: number;
  errorAt: string | null;
  errorAgeMs: number;
  errorReason: string | null;
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
  env: (home) => ({
    CURSOR_CONFIG_DIR: home,
    AGENT_CLI_CREDENTIAL_STORE: 'file',
  }),
  loginCommand: (home) =>
    `CURSOR_CONFIG_DIR=${home} AGENT_CLI_CREDENTIAL_STORE=file cursor-agent login`,
  loginArgv: () => ['cursor-agent', 'login'],
  defaultHome: () => path.join(os.homedir(), '.cursor'),
};

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
  } catch {
    return failed('Cursor usage collection failed', 'error');
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
  const refreshed = await refreshCursorTokens(ctx, credentials);
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await (ctx.fetchImpl ?? fetch)(USAGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        Authorization: `Bearer ${accessToken}`,
      },
      body: '{}',
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        status: response.status,
        usage: null,
        reason:
          response.status === 401 || response.status === 403
            ? 'Cursor usage endpoint rejected credentials'
            : `Cursor usage endpoint returned HTTP ${response.status}`,
      };
    }
    return { status: response.status, usage: await response.json(), reason: null };
  } catch (error) {
    return {
      status: null,
      usage: null,
      reason:
        error instanceof Error && error.name === 'AbortError'
          ? 'Cursor usage endpoint timed out'
          : 'Cursor usage endpoint request failed',
    };
  } finally {
    clearTimeout(timeout);
  }
}

interface LiveTokenCache {
  tokens: CursorTokens;
  cachedAtMs: number;
}

/** Rotated tokens stay in memory only. Concurrent refreshes for one home must
 * never race a single-use refresh token. */
const liveTokens = new Map<string, LiveTokenCache>();
const refreshInFlight = new Map<string, Promise<RefreshOutcome>>();

function rememberTokens(home: string, tokens: CursorTokens): void {
  liveTokens.set(path.resolve(home), { tokens, cachedAtMs: Date.now() });
}

function refreshCursorTokens(
  ctx: CollectContext,
  credentials: CursorTokens,
): Promise<RefreshOutcome> {
  const key = path.resolve(ctx.home);
  const pending = refreshInFlight.get(key);
  if (pending) return pending;
  const run = requestTokenRefresh(ctx, credentials).finally(() => refreshInFlight.delete(key));
  refreshInFlight.set(key, run);
  return run;
}

async function requestTokenRefresh(
  ctx: CollectContext,
  credentials: CursorTokens,
): Promise<RefreshOutcome> {
  if (!credentials.refreshToken) {
    return { tokens: null, reason: 'Cursor usage endpoint rejected credentials' };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await (ctx.fetchImpl ?? fetch)(REFRESH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: OAUTH_CLIENT_ID,
        refresh_token: credentials.refreshToken,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return { tokens: null, reason: 'Cursor token refresh was rejected' };
    }
    const payload: unknown = await response.json();
    const record = isRecord(payload) ? payload : null;
    if (record?.shouldLogout === true) {
      return { tokens: null, reason: 'Cursor token refresh was rejected' };
    }
    const accessToken = readString(record?.access_token);
    if (!accessToken) return { tokens: null, reason: 'Cursor token refresh was rejected' };
    return {
      tokens: {
        accessToken,
        refreshToken: readString(record?.refresh_token) ?? credentials.refreshToken,
      },
      reason: null,
    };
  } catch (error) {
    return {
      tokens: null,
      reason:
        error instanceof Error && error.name === 'AbortError'
          ? 'Cursor token refresh timed out'
          : 'Cursor token refresh failed',
    };
  } finally {
    clearTimeout(timeout);
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
    Number.isFinite(updatedMs) &&
    nowMs - updatedMs > STALE_MS &&
    !windows.some((window) => window.resetAt);
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
  const cursorUsed = firstPercent(plan, [
    'cursorModelsPercentUsed',
    'cursor_models_percent_used',
    'cursorModelsUsedPercent',
    'autoPercentUsed',
  ]);
  const otherUsed = firstPercent(plan, [
    'otherModelsPercentUsed',
    'other_models_percent_used',
    'otherModelsUsedPercent',
    'apiPercentUsed',
  ]);
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

function firstPercent(record: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = clampPercent(toNumber(record[key]));
    if (value !== null) return value;
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
    const authMtime = fs.statSync(path.join(home, 'auth.json'), { throwIfNoEntry: false })?.mtimeMs;
    if (authMtime !== undefined && authMtime > live.cachedAtMs) {
      liveTokens.delete(key);
    } else {
      return live.tokens;
    }
  }
  return (
    tokensFromAuthFile(path.join(home, 'auth.json')) ?? ideTokensIfDefaultHome(home, defaultHome)
  );
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

function isDefaultHome(home: string, defaultHome?: string): boolean {
  const expected = defaultHome ?? cursorAdapter.defaultHome();
  // The path itself must be the default home. A managed directory that merely
  // symlinks at ~/.cursor must not inherit the IDE session.
  if (path.resolve(home) !== path.resolve(expected)) return false;
  return sameRealPath(home, expected);
}

function sameRealPath(left: string, right: string): boolean {
  return canonicalize(left) === canonicalize(right);
}

function canonicalize(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
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
  const authFile = path.join(home, 'auth.json');
  if (fs.existsSync(authFile)) return identityFromUnknown(readJsonSync(authFile));
  if (!isDefaultHome(home)) return null;
  const db = ideStateDbPath();
  const token = readIdeValue(db, 'cursorAuth/accessToken');
  const fromJwt = identityFromJwt(token);
  const email = readIdeValue(db, 'cursorAuth/cachedEmail');
  const plan = readIdeValue(db, 'cursorAuth/stripeMembershipType');
  if (!fromJwt && !email && !plan) return null;
  return {
    account: fromJwt?.account ?? email,
    organization: fromJwt?.organization ?? null,
    plan: fromJwt?.plan ?? plan,
  };
}

function identityFromUnknown(value: unknown): ProviderIdentity | null {
  const tokens = tokensFromUnknown(value);
  return identityFromJwt(tokens?.accessToken ?? null);
}

function identityFromJwt(token: string | null): ProviderIdentity | null {
  const claims = jwtClaims(token);
  if (!claims) return null;
  const account = readString(claims.email) ?? readString(claims.sub);
  const plan = readString(claims.plan) ?? readString(claims.membershipType);
  if (!account && !plan) return null;
  return { account, organization: readString(claims.organization), plan };
}

function jwtClaims(token: string | null): Record<string, unknown> | null {
  if (!token) return null;
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const decoded = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
      'utf8',
    );
    const claims: unknown = JSON.parse(decoded);
    return isRecord(claims) ? claims : null;
  } catch {
    return null;
  }
}

async function credentialsChangedSince(
  home: string,
  errorAt: string | null,
  nowMs: number,
): Promise<boolean> {
  const errorMs = Date.parse(errorAt ?? '');
  if (!Number.isFinite(errorMs)) return false;
  // Only auth.json. state.vscdb is rewritten constantly while the IDE is open,
  // so its mtime would disable the error cooldown on every scheduler tick.
  const files = [path.join(home, 'auth.json')];
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

async function readUsageCache(file: string, nowMs: number): Promise<UsageCache> {
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

async function writeUsageCache(
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

async function writeUsageError(
  file: string,
  cache: UsageCache,
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

function readJsonSync(file: string): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
}
