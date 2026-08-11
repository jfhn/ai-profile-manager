import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codexAdapter } from './codex.js';

const dirs: string[] = [];
const now = Date.parse('2025-01-10T00:00:00Z');
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function home(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-codex-'));
  dirs.push(dir);
  return dir;
}

function writeSession(homeDir: string, timestamp: string, limits: unknown): void {
  const file = path.join(homeDir, 'sessions', '2025', '01', 'x.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `partial\n${JSON.stringify({ timestamp, payload: { rate_limits: limits } })}\n`,
  );
  fs.utimesSync(file, now / 1000, now / 1000);
}

function authValue(): Record<string, unknown> {
  return {
    OPENAI_API_KEY: null,
    tokens: {
      id_token: 'id-token-old',
      access_token: 'access-token-old',
      refresh_token: 'refresh-token-old',
      account_id: 'acct-123',
    },
    last_refresh: '2025-01-09T00:00:00.000Z',
  };
}

/** auth.json with an explicit mtime: the cooldown compares it to the error time. */
function writeAuth(homeDir: string, value: unknown = authValue(), mtimeMs = now - 60_000): void {
  const file = path.join(homeDir, 'auth.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
  fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
}

function localLimits(): unknown {
  return {
    primary: { used_percent: 20 },
    secondary: { used_percent: 40, reset_at: '2025-01-12T00:00:00Z' },
    plan_type: 'plus',
  };
}

/** Current wham/usage response shape (openai/codex backend-client tests). */
function whamUsage(): unknown {
  return {
    plan_type: 'pro',
    rate_limit: {
      primary_window: {
        used_percent: 12,
        limit_window_seconds: 18_000,
        reset_at: Date.parse('2025-01-10T02:00:00Z') / 1000,
      },
      secondary_window: {
        used_percent: 55,
        limit_window_seconds: 604_800,
        reset_at: Date.parse('2025-01-15T00:00:00Z') / 1000,
      },
    },
  };
}

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';

function router(
  handle: (
    url: string,
    init: RequestInit | undefined,
    call: number,
  ) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    return handle(url, init, urls.length);
  }) as typeof fetch;
  return { fetchImpl, urls };
}

describe('codex adapter', () => {
  it('uses the newest parseable record and emits only weekly during rollout', async () => {
    const dir = home();
    writeSession(dir, '2025-01-09T23:00:00Z', {
      primary: { used_percent: 20 },
      secondary: { used_percent: 40, reset_at: '2025-01-12T00:00:00Z' },
      plan_type: 'plus',
    });
    const result = await codexAdapter.collectUsage({
      home: dir,
      cacheDir: path.join(dir, 'cache'),
      allowNetwork: false,
      now,
    });
    expect(result.windows).toEqual([expect.objectContaining({ id: 'weekly', usedPercent: 40 })]);
    expect(result.planType).toBe('plus');
    expect(result.cacheStatus).toBe('live');
  });

  it('classifies the 2026 format where primary carries the weekly window', async () => {
    const dir = home();
    writeSession(dir, '2025-01-09T23:00:00Z', {
      limit_id: 'codex',
      primary: { used_percent: 3, window_minutes: 10080, resets_at: 1736726400 },
      secondary: null,
      plan_type: 'plus',
    });
    const result = await codexAdapter.collectUsage({
      home: dir,
      cacheDir: path.join(dir, 'cache'),
      allowNetwork: false,
      now,
    });
    expect(result.windows).toEqual([
      expect.objectContaining({ id: 'weekly', label: '7d', usedPercent: 3, remainingPercent: 97 }),
    ]);
    expect(result.windows[0]?.resetAt).toBe(new Date(1736726400 * 1000).toISOString());
  });

  it('marks old records without future resets stale and handles absent data', async () => {
    const dir = home();
    writeSession(dir, '2025-01-01T00:00:00Z', {
      primary: { used_percent: 20 },
      secondary: { used_percent: 40 },
    });
    const stale = await codexAdapter.collectUsage({
      home: dir,
      cacheDir: path.join(dir, 'cache'),
      allowNetwork: false,
      now,
    });
    expect(stale).toMatchObject({ cacheStatus: 'stale-cache', stale: true });
    const absent = await codexAdapter.collectUsage({
      home: path.join(dir, 'missing'),
      cacheDir: path.join(dir, 'cache'),
      allowNetwork: false,
      now,
    });
    expect(absent).toMatchObject({ windows: [], cacheStatus: 'live', stale: false, error: null });
  });

  it('fetches the usage endpoint and builds windows from the wham payload', async () => {
    const dir = home();
    writeAuth(dir);
    const { fetchImpl, urls } = router((url, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer access-token-old');
      expect(headers.get('chatgpt-account-id')).toBe('acct-123');
      return new Response(JSON.stringify(whamUsage()), { status: 200 });
    });
    const result = await codexAdapter.collectUsage({
      home: dir,
      cacheDir: path.join(dir, 'cache'),
      allowNetwork: true,
      now,
      fetchImpl,
    });
    expect(urls).toEqual([USAGE_URL]);
    expect(result.cacheStatus).toBe('live');
    // The five-hour window stays hidden during rollout; weekly comes from the
    // 604800-second secondary window with a unix-seconds reset.
    expect(result.windows).toEqual([
      expect.objectContaining({
        id: 'weekly',
        usedPercent: 55,
        resetAt: '2025-01-15T00:00:00.000Z',
      }),
    ]);
    expect(result.planType).toBe('pro');
    const cacheFile = path.join(dir, 'cache', 'codex-usage.json');
    expect(fs.statSync(cacheFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(cacheFile, 'utf8'))).toMatchObject({
      updatedAt: new Date(now).toISOString(),
      usage: { plan_type: 'pro' },
    });
  });

  it('accepts the legacy rate_limits response shape from the usage endpoint', async () => {
    const dir = home();
    writeAuth(dir);
    const { fetchImpl } = router(
      () => new Response(JSON.stringify({ rate_limits: localLimits() }), { status: 200 }),
    );
    const result = await codexAdapter.collectUsage({
      home: dir,
      cacheDir: path.join(dir, 'cache'),
      allowNetwork: true,
      now,
      fetchImpl,
    });
    expect(result.cacheStatus).toBe('live');
    expect(result.windows).toEqual([expect.objectContaining({ id: 'weekly', usedPercent: 40 })]);
    expect(result.planType).toBe('plus');
  });

  it('serves a fresh usage cache within the TTL without a network call', async () => {
    const dir = home();
    writeAuth(dir);
    const cacheFile = path.join(dir, 'cache', 'codex-usage.json');
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(
      cacheFile,
      JSON.stringify({ updatedAt: '2025-01-09T23:58:00Z', usage: whamUsage() }),
    );
    const { fetchImpl, urls } = router(() => {
      throw new Error('should not fetch');
    });
    const result = await codexAdapter.collectUsage({
      home: dir,
      cacheDir: path.join(dir, 'cache'),
      allowNetwork: true,
      now,
      fetchImpl,
    });
    expect(urls).toEqual([]);
    expect(result.cacheStatus).toBe('cache');
    expect(result.windows).toEqual([expect.objectContaining({ id: 'weekly', usedPercent: 55 })]);
  });

  it('refreshes the token on 401, retries once, and rewrites auth.json atomically', async () => {
    const dir = home();
    writeAuth(dir);
    const { fetchImpl, urls } = router(async (url, init) => {
      if (url === TOKEN_URL) {
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toMatchObject({
          client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
          grant_type: 'refresh_token',
          refresh_token: 'refresh-token-old',
        });
        return new Response(
          JSON.stringify({
            id_token: 'id-token-new',
            access_token: 'access-token-new',
            refresh_token: 'refresh-token-new',
          }),
          { status: 200 },
        );
      }
      const authorization = new Headers(init?.headers).get('authorization');
      if (authorization === 'Bearer access-token-old') return new Response('', { status: 401 });
      expect(authorization).toBe('Bearer access-token-new');
      return new Response(JSON.stringify(whamUsage()), { status: 200 });
    });
    const result = await codexAdapter.collectUsage({
      home: dir,
      cacheDir: path.join(dir, 'cache'),
      allowNetwork: true,
      now,
      fetchImpl,
    });
    expect(urls).toEqual([USAGE_URL, TOKEN_URL, USAGE_URL]);
    expect(result.cacheStatus).toBe('live');
    expect(result.windows).toEqual([expect.objectContaining({ id: 'weekly', usedPercent: 55 })]);
    const authFile = path.join(dir, 'auth.json');
    expect(fs.statSync(authFile).mode & 0o777).toBe(0o600);
    // Only the rotated token fields and last_refresh change; every other key
    // (including unknown ones) survives the atomic rewrite.
    expect(JSON.parse(fs.readFileSync(authFile, 'utf8'))).toEqual({
      OPENAI_API_KEY: null,
      tokens: {
        id_token: 'id-token-new',
        access_token: 'access-token-new',
        refresh_token: 'refresh-token-new',
        account_id: 'acct-123',
      },
      last_refresh: new Date(now).toISOString(),
    });
    expect(fs.readdirSync(dir).filter((name) => name.includes('.tmp'))).toEqual([]);
  });

  it('falls back to local data with an auth reason when the refresh is rejected', async () => {
    const dir = home();
    writeSession(dir, '2025-01-09T23:00:00Z', localLimits());
    writeAuth(dir);
    const original = fs.readFileSync(path.join(dir, 'auth.json'), 'utf8');
    const { fetchImpl, urls } = router((url) =>
      url === TOKEN_URL
        ? new Response(JSON.stringify({ error: { code: 'refresh_token_expired' } }), {
            status: 400,
          })
        : new Response('', { status: 401 }),
    );
    const result = await codexAdapter.collectUsage({
      home: dir,
      cacheDir: path.join(dir, 'cache'),
      allowNetwork: true,
      now,
      fetchImpl,
    });
    expect(urls).toEqual([USAGE_URL, TOKEN_URL]);
    expect(result).toMatchObject({ cacheStatus: 'stale-cache', stale: true, failureKind: 'auth' });
    expect(result.staleReason).toContain('run codex login');
    expect(result.windows).toEqual([expect.objectContaining({ id: 'weekly', usedPercent: 40 })]);
    expect(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8')).toBe(original);
    const text = JSON.stringify(result);
    expect(text).not.toContain('access-token-old');
    expect(text).not.toContain('refresh-token-old');
    expect(text).not.toContain('id-token-old');
  });

  it('records a cooldown after a network error and keeps serving local data', async () => {
    const dir = home();
    writeSession(dir, '2025-01-09T23:00:00Z', localLimits());
    writeAuth(dir);
    const failed = await codexAdapter.collectUsage({
      home: dir,
      cacheDir: path.join(dir, 'cache'),
      allowNetwork: true,
      now,
      fetchImpl: (async () => {
        throw new Error('connect ECONNREFUSED');
      }) as typeof fetch,
    });
    expect(failed).toMatchObject({ cacheStatus: 'stale-cache', stale: true, failureKind: 'error' });
    expect(failed.error).toContain('ECONNREFUSED');
    expect(failed.windows).toEqual([expect.objectContaining({ id: 'weekly', usedPercent: 40 })]);

    const { fetchImpl, urls } = router(() => {
      throw new Error('should not fetch');
    });
    const cooldown = await codexAdapter.collectUsage({
      home: dir,
      cacheDir: path.join(dir, 'cache'),
      allowNetwork: true,
      now: now + 60_000,
      fetchImpl,
    });
    expect(urls).toEqual([]);
    expect(cooldown).toMatchObject({
      cacheStatus: 'cooldown',
      stale: true,
      retryAfterSeconds: 240,
    });
    expect(cooldown.windows).toEqual([expect.objectContaining({ id: 'weekly', usedPercent: 40 })]);
    const text = JSON.stringify(cooldown);
    expect(text).not.toContain('access-token-old');
    expect(text).not.toContain('refresh-token-old');
  });

  it('never touches the network when allowNetwork is false', async () => {
    const dir = home();
    writeSession(dir, '2025-01-09T23:00:00Z', localLimits());
    writeAuth(dir);
    const { fetchImpl, urls } = router(() => {
      throw new Error('should not fetch');
    });
    const result = await codexAdapter.collectUsage({
      home: dir,
      cacheDir: path.join(dir, 'cache'),
      allowNetwork: false,
      now,
      fetchImpl,
    });
    expect(urls).toEqual([]);
    expect(result).toMatchObject({
      source: 'codex session rate_limits',
      cacheStatus: 'live',
      stale: false,
      staleReason: null,
      failureKind: null,
      error: null,
      planType: 'plus',
      retryAfterSeconds: null,
    });
    expect(result.windows).toEqual([expect.objectContaining({ id: 'weekly', usedPercent: 40 })]);
  });

  it('aborts the write-back and uses the newer tokens when auth.json changed mid-refresh', async () => {
    const dir = home();
    writeAuth(dir);
    const cliRotated = authValue();
    (cliRotated.tokens as Record<string, unknown>).access_token = 'access-token-cli';
    (cliRotated.tokens as Record<string, unknown>).refresh_token = 'refresh-token-cli';
    const { fetchImpl, urls } = router((url, init) => {
      if (url === TOKEN_URL) {
        // A live CLI wins the race and rotates auth.json before our response.
        fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify(cliRotated));
        return new Response(
          JSON.stringify({
            access_token: 'access-token-lost',
            refresh_token: 'refresh-token-lost',
          }),
          { status: 200 },
        );
      }
      const authorization = new Headers(init?.headers).get('authorization');
      if (authorization === 'Bearer access-token-old') return new Response('', { status: 401 });
      // The retry must use the CLI's newer tokens, not our superseded rotation.
      expect(authorization).toBe('Bearer access-token-cli');
      return new Response(JSON.stringify(whamUsage()), { status: 200 });
    });
    const result = await codexAdapter.collectUsage({
      home: dir,
      cacheDir: path.join(dir, 'cache'),
      allowNetwork: true,
      now,
      fetchImpl,
    });
    expect(urls).toEqual([USAGE_URL, TOKEN_URL, USAGE_URL]);
    expect(result.cacheStatus).toBe('live');
    expect(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8')).toBe(JSON.stringify(cliRotated));
  });
});
