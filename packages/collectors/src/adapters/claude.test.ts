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

function rateLimits(): unknown {
  return {
    rate_limits: {
      primary: { used_percent: 25, reset_at: '2025-01-10T01:00:00Z' },
      secondary: { used_percent: 60, reset_at: '2025-01-15T00:00:00Z' },
    },
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
