import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CollectResult, ProviderIdentity, UsageWindow } from '@apm/shared';
import type { CollectContext, ProviderAdapter } from '../adapter.js';
import { readTailBounded, statOrNull, walkFilesBounded } from '../bounded.js';
import { hasFutureReset, isRecord, makeQuotaWindow, readString, safeReason } from '../normalize.js';

const CODEX_STALE_MS = 24 * 60 * 60 * 1000;
const CODEX_SCAN_AGE_MS = 21 * 24 * 60 * 60 * 1000;
const SHOW_CODEX_FIVE_HOUR = false; // Temporary rollout switch; re-enabling is a one-line change.

interface LatestRateLimits {
  timestampMs: number;
  timestamp: string;
  rateLimits: Record<string, unknown>;
}

export const codexAdapter: ProviderAdapter = {
  provider: 'codex',
  displayName: 'Codex',
  capabilities: {
    usage: true,
    usageSources: ['local-files'],
    identity: true,
    windows: ['weekly'],
    notes: 'Usage is read from bounded session rate_limit events; the five-hour limit is temporarily hidden during OpenAI rollout.',
  },
  hasCredentials: (home) => isRecord(readJsonSync(path.join(home, 'auth.json'))),
  detectIdentity: (home) => codexIdentity(readJsonSync(path.join(home, 'auth.json'))),
  collectUsage: async (ctx) => collectCodexUsage(ctx),
  env: (home) => ({ CODEX_HOME: home }),
  loginCommand: (home) => `CODEX_HOME=${home} codex login`,
  defaultHome: () => path.join(os.homedir(), '.codex'),
};

async function collectCodexUsage(ctx: CollectContext): Promise<CollectResult> {
  const nowMs = ctx.now ?? Date.now();
  try {
    const files = await walkFilesBounded(path.join(ctx.home, 'sessions'), {
      accept: (name) => name.endsWith('.jsonl'),
      newestFirst: true,
      maxFiles: 512,
    });
    const entries = await Promise.all(files.map(async (file) => ({ file, stat: await statOrNull(file) })));
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
    const primary = makeQuotaWindow('five_hour', '5h', latest.rateLimits.primary, nowMs);
    const secondary = makeQuotaWindow('weekly', '7d', latest.rateLimits.secondary, nowMs);
    const windows = [SHOW_CODEX_FIVE_HOUR ? primary : null, secondary].filter((window): window is UsageWindow => Boolean(window));
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
      staleReason: stale ? 'Codex quota data is older than 24 hours and has no active reset window' : null,
      failureKind: null,
      error: null,
      planType: readString(latest.rateLimits.plan_type),
      retryAfterSeconds: null,
    };
  } catch (error) {
    return failed(safeReason(error instanceof Error ? error.message : error));
  }
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

function unavailable(): CollectResult {
  return {
    windows: [], source: 'codex session rate_limits', cacheStatus: 'live', dataUpdatedAt: null,
    stale: false, staleReason: 'Codex rate limits appear after Codex records a token_count event',
    failureKind: null, error: null, planType: null, retryAfterSeconds: null,
  };
}

function failed(reason: string): CollectResult {
  return {
    windows: [], source: 'codex session rate_limits', cacheStatus: 'error', dataUpdatedAt: null,
    stale: true, staleReason: reason, failureKind: 'error', error: safeReason(reason), planType: null, retryAfterSeconds: null,
  };
}

function codexIdentity(value: unknown): ProviderIdentity | null {
  if (!isRecord(value)) return null;
  const tokens = isRecord(value.tokens) ? value.tokens : value;
  const claims = jwtClaims(readString(tokens.id_token));
  if (!claims) return null;
  const auth = isRecord(claims['https://api.openai.com/auth']) ? claims['https://api.openai.com/auth'] : claims;
  return {
    account: readString(claims.email) ?? readString(auth.email),
    organization: readString(auth.organization) ?? readString(auth.organization_name) ?? readString(claims.organization),
    plan: readString(auth.chatgpt_plan_type) ?? readString(claims.chatgpt_plan_type) ?? readString(auth.plan_type),
  };
}

function jwtClaims(token: string | null): Record<string, unknown> | null {
  if (!token) return null;
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const decoded = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const claims: unknown = JSON.parse(decoded);
    return isRecord(claims) ? claims : null;
  } catch {
    return null;
  }
}

function readJsonSync(file: string): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
}
