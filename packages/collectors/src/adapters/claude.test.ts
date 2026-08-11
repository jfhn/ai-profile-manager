import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeAdapter } from './claude.js';

const dirs: string[] = [];
const now = Date.parse('2025-01-10T00:00:00Z');
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function setup(): { home: string; cache: string; global: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-claude-'));
  dirs.push(root);
  const home = path.join(root, 'home');
  const cache = path.join(root, 'cache');
  const global = path.join(root, 'global');
  fs.mkdirSync(home, { recursive: true });
  return { home, cache, global };
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

/** Credentials with an explicit mtime: the adapter compares it to the error time. */
function writeCredentials(home: string, mtimeMs: number): void {
  const file = path.join(home, '.credentials.json');
  writeJson(file, { claudeAiOauth: { accessToken: 'secret', expiresAt: '2025-01-11T00:00:00Z' } });
  fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
}

const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';

/** Refreshable credentials with extra fields the write-back must preserve. */
function writeRefreshableCredentials(home: string, expiresAtMs: number): string {
  const file = path.join(home, '.credentials.json');
  writeJson(file, {
    claudeAiOauth: {
      accessToken: 'stale-access-token-1',
      refreshToken: 'stale-refresh-token-1',
      expiresAt: expiresAtMs,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'max',
    },
    unrelatedTopLevel: { keep: true },
  });
  return file;
}

function authHeader(init?: RequestInit): string | null {
  const headers = init?.headers;
  return headers && !Array.isArray(headers) && !(headers instanceof Headers)
    ? ((headers as Record<string, string>).Authorization ?? null)
    : null;
}

function rateLimits(): unknown {
  return {
    rate_limits: {
      primary: { used_percent: 25, reset_at: '2025-01-10T01:00:00Z' },
      secondary: { used_percent: 60, reset_at: '2025-01-15T00:00:00Z' },
    },
  };
}

/** Production OAuth usage response captured 2026-08-10: the model-scoped weekly
 * window appears only inside the `limits` array, with the top-level scoped
 * keys null. */
function oauthLimitsPayload(): unknown {
  return {
    five_hour: { utilization: 14, resets_at: '2026-08-11T00:50:00.927546+00:00' },
    seven_day: { utilization: 53, resets_at: '2026-08-11T05:00:00.927571+00:00' },
    seven_day_opus: null,
    seven_day_sonnet: null,
    limits: [
      {
        kind: 'session',
        group: 'session',
        percent: 14,
        severity: 'normal',
        resets_at: '2026-08-11T00:50:00.927546+00:00',
        scope: null,
        is_active: false,
      },
      {
        kind: 'weekly_all',
        group: 'weekly',
        percent: 53,
        severity: 'normal',
        resets_at: '2026-08-11T05:00:00.927571+00:00',
        scope: null,
        is_active: false,
      },
      {
        kind: 'weekly_scoped',
        group: 'weekly',
        percent: 84,
        severity: 'warning',
        resets_at: '2026-08-11T05:00:00.927872+00:00',
        scope: { model: { id: null, display_name: 'Fable' } },
        is_active: true,
      },
    ],
  };
}

describe('claude adapter', () => {
  it('uses a fresh default-home statusline cache and appends a valid Fable window', async () => {
    const { home, cache, global } = setup();
    const status = path.join(global, 'claude-rate-limits.json');
    const fable = path.join(global, 'claude-scoped-weekly.json');
    writeJson(status, { updatedAt: '2025-01-09T23:55:00Z', ...rateLimits() });
    writeJson(fable, { model: ' Fable-5 ', percent: 10, resets_at: '2025-01-16T00:00:00Z' });
    fs.utimesSync(fable, now / 1000, now / 1000);
    const result = await claudeAdapter.collectUsage({
      home,
      defaultHome: home,
      cacheDir: cache,
      globalCacheDir: global,
      allowNetwork: false,
      now,
    });
    expect(result.cacheStatus).toBe('cache');
    expect(result.windows.map((window) => window.id)).toEqual([
      'five_hour',
      'weekly',
      'fable_weekly',
    ]);
  });

  it('rejects invalid Fable data and never reads global cache for another profile', async () => {
    const { home, cache, global } = setup();
    writeJson(path.join(global, 'claude-rate-limits.json'), {
      updatedAt: '2025-01-09T23:55:00Z',
      ...rateLimits(),
    });
    writeJson(path.join(global, 'claude-scoped-weekly.json'), {
      model: 'other',
      percent: 50,
      resets_at: '2025-01-16T00:00:00Z',
    });
    fs.utimesSync(path.join(global, 'claude-scoped-weekly.json'), now / 1000, now / 1000);
    const result = await claudeAdapter.collectUsage({
      home,
      defaultHome: path.join(home, 'different'),
      cacheDir: cache,
      globalCacheDir: global,
      allowNetwork: false,
      now,
    });
    expect(result.windows).toEqual([]);
    expect(result.staleReason).toContain('No per-account Claude usage source');
  });

  it('uses Fable alone only when its model, percent, mtime, and reset are valid', async () => {
    const { home, cache, global } = setup();
    const file = path.join(global, 'claude-scoped-weekly.json');
    writeJson(file, { model: 'claude-fable-5', percent: 30, resets_at: '2025-01-16T00:00:00Z' });
    fs.utimesSync(file, now / 1000, now / 1000);
    const accepted = await claudeAdapter.collectUsage({
      home,
      defaultHome: home,
      cacheDir: cache,
      globalCacheDir: global,
      allowNetwork: false,
      now,
    });
    expect(accepted).toMatchObject({
      cacheStatus: 'cache',
      windows: [expect.objectContaining({ id: 'fable_weekly', remainingPercent: 70 })],
    });
    writeJson(file, { model: 'fable', percent: 101, resets_at: '2025-01-16T00:00:00Z' });
    fs.utimesSync(file, now / 1000, now / 1000);
    const rejected = await claudeAdapter.collectUsage({
      home,
      defaultHome: home,
      cacheDir: cache,
      globalCacheDir: global,
      allowNetwork: false,
      now,
    });
    expect(rejected.windows).toEqual([]);
  });

  it('parses a Fable scoped weekly window from the OAuth payload for non-default profiles', async () => {
    const { home, cache, global } = setup();
    writeJson(path.join(home, '.credentials.json'), {
      claudeAiOauth: { accessToken: 'secret', expiresAt: '2025-01-11T00:00:00Z' },
    });
    const result = await claudeAdapter.collectUsage({
      home,
      defaultHome: path.join(home, 'different'),
      cacheDir: cache,
      globalCacheDir: global,
      allowNetwork: true,
      now,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            rate_limits: {
              primary: { used_percent: 25, reset_at: '2025-01-10T01:00:00Z' },
              secondary: { used_percent: 60, reset_at: '2025-01-15T00:00:00Z' },
              seven_day_fable: { used_percent: 40, reset_at: '2025-01-16T00:00:00Z' },
            },
          }),
          { status: 200 },
        ),
    });
    expect(result.cacheStatus).toBe('live');
    expect(result.windows).toEqual([
      expect.objectContaining({ id: 'five_hour' }),
      expect.objectContaining({ id: 'weekly' }),
      expect.objectContaining({ id: 'fable_weekly', label: 'Fable 5 weekly', usedPercent: 40 }),
    ]);
  });

  it('reads the model-scoped weekly window from the OAuth limits array', async () => {
    const { home, cache, global } = setup();
    writeCredentials(home, now - 60_000);
    const result = await claudeAdapter.collectUsage({
      home,
      defaultHome: path.join(home, 'different'),
      cacheDir: cache,
      globalCacheDir: global,
      allowNetwork: true,
      now,
      fetchImpl: async () => new Response(JSON.stringify(oauthLimitsPayload()), { status: 200 }),
    });
    expect(result.cacheStatus).toBe('live');
    expect(result.windows).toEqual([
      expect.objectContaining({ id: 'five_hour', usedPercent: 14 }),
      expect.objectContaining({ id: 'weekly', usedPercent: 53 }),
      expect.objectContaining({
        id: 'fable_weekly',
        label: 'Fable 5 weekly',
        usedPercent: 84,
        remainingPercent: 16,
        resetAt: '2026-08-11T05:00:00.927Z',
      }),
    ]);
  });

  it('builds every window from the limits array when top-level keys are absent', async () => {
    const { home, cache, global } = setup();
    writeCredentials(home, now - 60_000);
    const payload = oauthLimitsPayload() as Record<string, unknown>;
    const result = await claudeAdapter.collectUsage({
      home,
      defaultHome: path.join(home, 'different'),
      cacheDir: cache,
      globalCacheDir: global,
      allowNetwork: true,
      now,
      fetchImpl: async () =>
        new Response(JSON.stringify({ limits: payload.limits }), { status: 200 }),
    });
    expect(result.windows).toEqual([
      expect.objectContaining({ id: 'five_hour', usedPercent: 14 }),
      expect.objectContaining({ id: 'weekly', usedPercent: 53 }),
      expect.objectContaining({ id: 'fable_weekly', usedPercent: 84 }),
    ]);
  });

  it('keeps top-level windows authoritative over conflicting limits entries', async () => {
    const { home, cache, global } = setup();
    writeCredentials(home, now - 60_000);
    const result = await claudeAdapter.collectUsage({
      home,
      defaultHome: path.join(home, 'different'),
      cacheDir: cache,
      globalCacheDir: global,
      allowNetwork: true,
      now,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            seven_day: { utilization: 53, resets_at: '2026-08-11T05:00:00+00:00' },
            limits: [
              { kind: 'weekly_all', percent: 99, resets_at: '2026-08-12T05:00:00+00:00' },
              'not-an-entry',
              { kind: 'weekly_scoped' },
            ],
          }),
          { status: 200 },
        ),
    });
    // The malformed weekly_scoped entry (no percent) must not produce a window.
    expect(result.windows).toEqual([
      expect.objectContaining({
        id: 'weekly',
        usedPercent: 53,
        resetAt: '2026-08-11T05:00:00.000Z',
      }),
    ]);
  });

  it('does not let the scoped weekly cache replace a limits-derived Fable window', async () => {
    const { home, cache, global } = setup();
    writeCredentials(home, now - 60_000);
    const fableFile = path.join(global, 'claude-scoped-weekly.json');
    writeJson(fableFile, { model: 'fable', percent: 51, resets_at: '2026-08-16T00:00:00Z' });
    fs.utimesSync(fableFile, now / 1000, now / 1000);
    const result = await claudeAdapter.collectUsage({
      home,
      defaultHome: home,
      cacheDir: cache,
      globalCacheDir: global,
      allowNetwork: true,
      now,
      fetchImpl: async () => new Response(JSON.stringify(oauthLimitsPayload()), { status: 200 }),
    });
    expect(result.windows.filter((window) => window.id === 'fable_weekly')).toEqual([
      expect.objectContaining({ id: 'fable_weekly', usedPercent: 84, remainingPercent: 16 }),
    ]);
    expect(result.source).not.toContain('Fable scoped weekly cache');
  });

  it('prefers per-profile Fable data over the scoped weekly cache on the default home', async () => {
    const { home, cache, global } = setup();
    writeJson(path.join(global, 'claude-rate-limits.json'), {
      updatedAt: '2025-01-09T23:55:00Z',
      rate_limits: {
        primary: { used_percent: 25, reset_at: '2025-01-10T01:00:00Z' },
        seven_day_fable: { used_percent: 40, reset_at: '2025-01-16T00:00:00Z' },
      },
    });
    const fableFile = path.join(global, 'claude-scoped-weekly.json');
    writeJson(fableFile, { model: 'fable', percent: 10, resets_at: '2025-01-16T00:00:00Z' });
    fs.utimesSync(fableFile, now / 1000, now / 1000);
    const result = await claudeAdapter.collectUsage({
      home,
      defaultHome: home,
      cacheDir: cache,
      globalCacheDir: global,
      allowNetwork: false,
      now,
    });
    expect(result.windows).toEqual([
      expect.objectContaining({ id: 'five_hour' }),
      expect.objectContaining({ id: 'fable_weekly', usedPercent: 40 }),
    ]);
    expect(result.source).not.toContain('Fable scoped weekly cache');
  });

  it('uses OAuth, blanks stale cache after auth failure, and cools down after timeout', async () => {
    const { home, cache, global } = setup();
    writeCredentials(home, now - 60_000);
    const success = await claudeAdapter.collectUsage({
      home,
      defaultHome: home,
      cacheDir: cache,
      globalCacheDir: global,
      allowNetwork: true,
      now,
      fetchImpl: async () => new Response(JSON.stringify(rateLimits()), { status: 200 }),
    });
    expect(success).toMatchObject({ cacheStatus: 'live' });
    const auth = await claudeAdapter.collectUsage({
      home,
      defaultHome: home,
      cacheDir: cache,
      globalCacheDir: global,
      allowNetwork: true,
      now: now + 6 * 60 * 1000,
      fetchImpl: async () => new Response('', { status: 401 }),
    });
    expect(auth).toMatchObject({ cacheStatus: 'stale-cache', failureKind: 'auth', windows: [] });
    const timeout = await claudeAdapter.collectUsage({
      home,
      defaultHome: home,
      cacheDir: cache,
      globalCacheDir: global,
      allowNetwork: true,
      now: now + 12 * 60 * 1000,
      fetchImpl: async () => {
        const error = new Error('timed out');
        error.name = 'AbortError';
        throw error;
      },
    });
    expect(timeout.failureKind).toBe('timeout');
    const cooldown = await claudeAdapter.collectUsage({
      home,
      defaultHome: home,
      cacheDir: cache,
      globalCacheDir: global,
      allowNetwork: true,
      now: now + 12 * 60 * 1000 + 1_000,
      fetchImpl: async () => {
        throw new Error('should not fetch');
      },
    });
    expect(cooldown.cacheStatus).toBe('cooldown');
  });

  it('bypasses the OAuth cooldown for a forced refresh but not for a background one', async () => {
    const { home, cache, global } = setup();
    writeCredentials(home, now - 60_000);
    const failed = await claudeAdapter.collectUsage({
      home,
      defaultHome: home,
      cacheDir: cache,
      globalCacheDir: global,
      allowNetwork: true,
      now,
      fetchImpl: async () => new Response('', { status: 500 }),
    });
    expect(failed.cacheStatus).toBe('error');

    const background = await claudeAdapter.collectUsage({
      home,
      defaultHome: home,
      cacheDir: cache,
      globalCacheDir: global,
      allowNetwork: true,
      now: now + 60_000,
      fetchImpl: async () => {
        throw new Error('should not fetch');
      },
    });
    expect(background.cacheStatus).toBe('cooldown');

    const forced = await claudeAdapter.collectUsage({
      home,
      defaultHome: home,
      cacheDir: cache,
      globalCacheDir: global,
      allowNetwork: true,
      now: now + 60_000,
      force: true,
      fetchImpl: async () => new Response(JSON.stringify(rateLimits()), { status: 200 }),
    });
    expect(forced.cacheStatus).toBe('live');
    expect(forced.windows.map((window) => window.id)).toEqual(['five_hour', 'weekly']);
  });

  it('ignores fresh caches on a forced refresh and still falls back when the fetch fails', async () => {
    const { home, cache, global } = setup();
    writeCredentials(home, now - 60_000);
    writeJson(path.join(global, 'claude-rate-limits.json'), {
      updatedAt: '2025-01-09T23:59:00Z',
      rate_limits: { primary: { used_percent: 5, reset_at: '2025-01-10T01:00:00Z' } },
    });
    writeJson(path.join(cache, 'claude-oauth-usage.json'), {
      updatedAt: '2025-01-09T23:59:00Z',
      usage: rateLimits(),
    });

    const cached = await claudeAdapter.collectUsage({
      home,
      defaultHome: home,
      cacheDir: cache,
      globalCacheDir: global,
      allowNetwork: true,
      now,
      fetchImpl: async () => {
        throw new Error('should not fetch');
      },
    });
    expect(cached.cacheStatus).toBe('cache');
    expect(cached.windows).toEqual([expect.objectContaining({ id: 'five_hour', usedPercent: 5 })]);

    const forced = await claudeAdapter.collectUsage({
      home,
      defaultHome: home,
      cacheDir: cache,
      globalCacheDir: global,
      allowNetwork: true,
      now,
      force: true,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ rate_limits: { primary: { used_percent: 80, reset_at: null } } }),
          { status: 200 },
        ),
    });
    expect(forced.cacheStatus).toBe('live');
    expect(forced.windows).toEqual([expect.objectContaining({ id: 'five_hour', usedPercent: 80 })]);

    const failedForce = await claudeAdapter.collectUsage({
      home,
      defaultHome: home,
      cacheDir: cache,
      globalCacheDir: global,
      allowNetwork: true,
      now: now + 1_000,
      force: true,
      fetchImpl: async () => new Response('', { status: 500 }),
    });
    expect(failedForce).toMatchObject({ cacheStatus: 'stale-cache', stale: true });
    expect(failedForce.windows).toEqual([
      expect.objectContaining({ id: 'five_hour', usedPercent: 80 }),
    ]);
    expect(failedForce.staleReason).toContain('HTTP 500');
  });

  it('keeps statusline windows when a forced fetch fails and the OAuth cache is unusable', async () => {
    const { home, cache, global } = setup();
    writeCredentials(home, now - 60_000);
    writeJson(path.join(global, 'claude-rate-limits.json'), {
      updatedAt: '2025-01-09T23:59:00Z',
      rate_limits: { primary: { used_percent: 5, reset_at: '2025-01-10T01:00:00Z' } },
    });
    // A 200 response with an unexpected body shape: truthy, but no windows.
    writeJson(path.join(cache, 'claude-oauth-usage.json'), {
      updatedAt: '2025-01-09T23:59:00Z',
      usage: {},
    });

    const result = await claudeAdapter.collectUsage({
      home,
      defaultHome: home,
      cacheDir: cache,
      globalCacheDir: global,
      allowNetwork: true,
      now,
      force: true,
      fetchImpl: async () => new Response('', { status: 500 }),
    });
    expect(result.windows).toEqual([expect.objectContaining({ id: 'five_hour', usedPercent: 5 })]);
    expect(result).toMatchObject({ cacheStatus: 'stale-cache', stale: true });
    expect(result.staleReason).toContain('HTTP 500');
    expect(result.error).toContain('HTTP 500');
  });

  it('treats an unreadable HTTP 200 as a failure and never caches it', async () => {
    const { home, cache, global } = setup();
    writeCredentials(home, now - 60_000);
    writeJson(path.join(global, 'claude-rate-limits.json'), {
      updatedAt: '2025-01-09T23:59:00Z',
      rate_limits: { primary: { used_percent: 5, reset_at: '2025-01-10T01:00:00Z' } },
    });
    const oauthFile = path.join(cache, 'claude-oauth-usage.json');

    const result = await claudeAdapter.collectUsage({
      home,
      defaultHome: home,
      cacheDir: cache,
      globalCacheDir: global,
      allowNetwork: true,
      now,
      force: true,
      fetchImpl: async () => new Response(JSON.stringify({ unexpected: true }), { status: 200 }),
    });
    expect(result.windows).toEqual([expect.objectContaining({ id: 'five_hour', usedPercent: 5 })]);
    expect(result.cacheStatus).toBe('stale-cache');
    expect(result.stale).toBe(true);
    expect(result.staleReason).toContain('no recognizable rate limits');
    expect(JSON.parse(fs.readFileSync(oauthFile, 'utf8'))).toMatchObject({ usage: null });
  });

  it('accepts a well-formed response that reports zero usage', async () => {
    const { home, cache, global } = setup();
    writeCredentials(home, now - 60_000);
    const result = await claudeAdapter.collectUsage({
      home,
      defaultHome: home,
      cacheDir: cache,
      globalCacheDir: global,
      allowNetwork: true,
      now,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            rate_limits: { primary: { used_percent: 0, reset_at: '2025-01-10T01:00:00Z' } },
          }),
          { status: 200 },
        ),
    });
    expect(result.cacheStatus).toBe('live');
    expect(result.windows).toEqual([
      expect.objectContaining({ id: 'five_hour', usedPercent: 0, remainingPercent: 100 }),
    ]);
  });

  it('shows statusline data instead of rejected OAuth cache on an auth failure', async () => {
    const { home, cache, global } = setup();
    writeCredentials(home, now - 60_000);
    writeJson(path.join(global, 'claude-rate-limits.json'), {
      updatedAt: '2025-01-09T23:59:00Z',
      rate_limits: { primary: { used_percent: 5, reset_at: '2025-01-10T01:00:00Z' } },
    });
    writeJson(path.join(cache, 'claude-oauth-usage.json'), {
      updatedAt: '2025-01-09T23:59:00Z',
      usage: rateLimits(),
    });

    const result = await claudeAdapter.collectUsage({
      home,
      defaultHome: home,
      cacheDir: cache,
      globalCacheDir: global,
      allowNetwork: true,
      now,
      force: true,
      fetchImpl: async () => new Response('', { status: 401 }),
    });
    // The rejected session's own cached numbers stay hidden; the statusline
    // cache describes the same default-home account and is shown stale.
    expect(result.source).toBe('claude statusLine rate_limits');
    expect(result.windows).toEqual([expect.objectContaining({ id: 'five_hour', usedPercent: 5 })]);
    expect(result).toMatchObject({ cacheStatus: 'stale-cache', stale: true, failureKind: 'auth' });
  });

  it('keeps the cooldown when the credentials mtime is in the future', async () => {
    const { home, cache, global } = setup();
    writeCredentials(home, now - 60_000);
    const failed = await claudeAdapter.collectUsage({
      home,
      defaultHome: home,
      cacheDir: cache,
      globalCacheDir: global,
      allowNetwork: true,
      now,
      fetchImpl: async () => new Response('', { status: 500 }),
    });
    expect(failed.cacheStatus).toBe('error');

    // Clock skew or a restored backup must not disable the cooldown forever.
    writeCredentials(home, now + 60 * 60 * 1000);
    const cooldown = await claudeAdapter.collectUsage({
      home,
      defaultHome: home,
      cacheDir: cache,
      globalCacheDir: global,
      allowNetwork: true,
      now: now + 60_000,
      fetchImpl: async () => {
        throw new Error('should not fetch');
      },
    });
    expect(cooldown.cacheStatus).toBe('cooldown');
  });

  it('refreshes an expired token, fetches usage with the new one, and rewrites credentials', async () => {
    const { home, cache, global } = setup();
    const file = writeRefreshableCredentials(home, now - 60_000);
    const calls: { url: string; body: unknown; auth: string | null }[] = [];
    const result = await claudeAdapter.collectUsage({
      home,
      defaultHome: home,
      cacheDir: cache,
      globalCacheDir: global,
      allowNetwork: true,
      now,
      fetchImpl: async (input, init) => {
        const url = String(input);
        calls.push({
          url,
          body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
          auth: authHeader(init),
        });
        if (url === TOKEN_URL)
          return new Response(
            JSON.stringify({
              access_token: 'fresh-access-token-2',
              refresh_token: 'fresh-refresh-token-2',
              expires_in: 28_800,
            }),
            { status: 200 },
          );
        return new Response(JSON.stringify(rateLimits()), { status: 200 });
      },
    });
    expect(result.cacheStatus).toBe('live');
    expect(result.windows.map((window) => window.id)).toEqual(['five_hour', 'weekly']);
    expect(calls.map((call) => call.url)).toEqual([
      TOKEN_URL,
      'https://api.anthropic.com/api/oauth/usage',
    ]);
    expect(calls[0].body).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'stale-refresh-token-1',
      client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    });
    expect(calls[1].auth).toBe('Bearer fresh-access-token-2');
    // Every untouched field survives; expiresAt is epoch milliseconds like the CLI writes.
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      unrelatedTopLevel: { keep: true },
      claudeAiOauth: {
        accessToken: 'fresh-access-token-2',
        refreshToken: 'fresh-refresh-token-2',
        expiresAt: now + 28_800 * 1000,
        scopes: ['user:inference', 'user:profile'],
        subscriptionType: 'max',
      },
    });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(result)).not.toMatch(/token-[12]/);
  });

  it('reports an auth re-login reason when the refresh is rejected and keeps credentials', async () => {
    const { home, cache, global } = setup();
    const file = writeRefreshableCredentials(home, now - 60_000);
    const before = fs.readFileSync(file, 'utf8');
    const result = await claudeAdapter.collectUsage({
      home,
      defaultHome: home,
      cacheDir: cache,
      globalCacheDir: global,
      allowNetwork: true,
      now,
      fetchImpl: async (input) => {
        if (String(input) === TOKEN_URL)
          return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
        throw new Error('usage endpoint must not be called with an expired token');
      },
    });
    expect(result.failureKind).toBe('auth');
    expect(result.error).toContain('Claude OAuth token refresh was rejected');
    expect(result.error).toContain('claude auth login');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(JSON.stringify(result)).not.toMatch(/token-1/);
  });

  it('reports a refresh server error without leaking the response body', async () => {
    const { home, cache, global } = setup();
    const file = writeRefreshableCredentials(home, now - 60_000);
    const before = fs.readFileSync(file, 'utf8');
    const result = await claudeAdapter.collectUsage({
      home,
      defaultHome: home,
      cacheDir: cache,
      globalCacheDir: global,
      allowNetwork: true,
      now,
      fetchImpl: async () => new Response('body-with-secret-token-material', { status: 500 }),
    });
    expect(result.failureKind).toBe('error');
    expect(result.error).toBe('Claude OAuth refresh endpoint returned HTTP 500');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('never calls the token endpoint while the access token is still valid', async () => {
    const { home, cache, global } = setup();
    writeRefreshableCredentials(home, now + 60 * 60 * 1000);
    const urls: string[] = [];
    const result = await claudeAdapter.collectUsage({
      home,
      defaultHome: home,
      cacheDir: cache,
      globalCacheDir: global,
      allowNetwork: true,
      now,
      fetchImpl: async (input) => {
        urls.push(String(input));
        return new Response(JSON.stringify(rateLimits()), { status: 200 });
      },
    });
    expect(result.cacheStatus).toBe('live');
    expect(urls).toEqual(['https://api.anthropic.com/api/oauth/usage']);
  });

  it('refreshes and retries once when a valid-looking token is rejected', async () => {
    const { home, cache, global } = setup();
    const file = writeRefreshableCredentials(home, now + 60 * 60 * 1000);
    const calls: { url: string; auth: string | null }[] = [];
    const result = await claudeAdapter.collectUsage({
      home,
      defaultHome: home,
      cacheDir: cache,
      globalCacheDir: global,
      allowNetwork: true,
      now,
      fetchImpl: async (input, init) => {
        const url = String(input);
        calls.push({ url, auth: authHeader(init) });
        if (url === TOKEN_URL)
          return new Response(
            JSON.stringify({ access_token: 'fresh-access-token-2', expires_in: 28_800 }),
            { status: 200 },
          );
        return calls.filter((call) => call.url !== TOKEN_URL).length === 1
          ? new Response('', { status: 401 })
          : new Response(JSON.stringify(rateLimits()), { status: 200 });
      },
    });
    expect(result.cacheStatus).toBe('live');
    expect(calls.map((call) => call.url)).toEqual([
      'https://api.anthropic.com/api/oauth/usage',
      TOKEN_URL,
      'https://api.anthropic.com/api/oauth/usage',
    ]);
    expect(calls[2].auth).toBe('Bearer fresh-access-token-2');
    // The response carried no rotated refresh token, so the old one stays.
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).claudeAiOauth).toMatchObject({
      accessToken: 'fresh-access-token-2',
      refreshToken: 'stale-refresh-token-1',
    });
  });

  it('aborts the write and uses the newer on-disk token when credentials change mid-refresh', async () => {
    const { home, cache, global } = setup();
    const file = writeRefreshableCredentials(home, now - 60_000);
    const cliCredentials = {
      claudeAiOauth: {
        accessToken: 'cli-access-token-3',
        refreshToken: 'cli-refresh-token-3',
        expiresAt: now + 60 * 60 * 1000,
      },
    };
    const auths: (string | null)[] = [];
    const result = await claudeAdapter.collectUsage({
      home,
      defaultHome: home,
      cacheDir: cache,
      globalCacheDir: global,
      allowNetwork: true,
      now,
      fetchImpl: async (input, init) => {
        if (String(input) === TOKEN_URL) {
          // A live CLI sharing this home refreshes first, mid-request.
          writeJson(file, cliCredentials);
          return new Response(
            JSON.stringify({ access_token: 'fresh-access-token-2', expires_in: 28_800 }),
            { status: 200 },
          );
        }
        auths.push(authHeader(init));
        return new Response(JSON.stringify(rateLimits()), { status: 200 });
      },
    });
    expect(result.cacheStatus).toBe('live');
    expect(auths).toEqual(['Bearer cli-access-token-3']);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(cliCredentials);
  });

  it('never attempts a refresh when network access is disabled', async () => {
    const { home, cache, global } = setup();
    writeRefreshableCredentials(home, now - 60_000);
    let called = false;
    const result = await claudeAdapter.collectUsage({
      home,
      defaultHome: home,
      cacheDir: cache,
      globalCacheDir: global,
      allowNetwork: false,
      now,
      fetchImpl: async () => {
        called = true;
        throw new Error('should not fetch');
      },
    });
    expect(called).toBe(false);
    expect(result.windows).toEqual([]);
  });

  it('keeps the expired-token message when no refresh token exists', async () => {
    const { home, cache, global } = setup();
    writeJson(path.join(home, '.credentials.json'), {
      claudeAiOauth: { accessToken: 'stale-access-token-1', expiresAt: now - 60_000 },
    });
    const result = await claudeAdapter.collectUsage({
      home,
      defaultHome: home,
      cacheDir: cache,
      globalCacheDir: global,
      allowNetwork: true,
      now,
      fetchImpl: async () => {
        throw new Error('should not fetch without a refresh token');
      },
    });
    expect(result.failureKind).toBe('auth');
    expect(result.error).toContain('Claude OAuth access token is expired');
    expect(JSON.stringify(result)).not.toMatch(/token-1/);
  });

  it('retries during the cooldown when credentials changed after the error', async () => {
    const { home, cache, global } = setup();
    const credentials = path.join(home, '.credentials.json');
    writeJson(credentials, { claudeAiOauth: {} });
    fs.utimesSync(credentials, (now - 60_000) / 1000, (now - 60_000) / 1000);
    const failed = await claudeAdapter.collectUsage({
      home,
      defaultHome: home,
      cacheDir: cache,
      globalCacheDir: global,
      allowNetwork: true,
      now,
      fetchImpl: async () => {
        throw new Error('should not fetch without credentials');
      },
    });
    expect(failed.staleReason).toContain('Claude OAuth credentials are missing');

    // A login after the error invalidates the cooldown even without force.
    writeCredentials(home, now + 30_000);
    const retried = await claudeAdapter.collectUsage({
      home,
      defaultHome: home,
      cacheDir: cache,
      globalCacheDir: global,
      allowNetwork: true,
      now: now + 60_000,
      fetchImpl: async () => new Response(JSON.stringify(rateLimits()), { status: 200 }),
    });
    expect(retried.cacheStatus).toBe('live');
  });
});
