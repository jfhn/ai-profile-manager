import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { cursorAdapter, cursorWindows } from './cursor.js';

const dirs: string[] = [];
const now = Date.parse('2026-08-19T12:00:00Z');
const originalHome = process.env.HOME;
const originalXdg = process.env.XDG_CONFIG_HOME;

afterEach(() => {
  dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
});

const USAGE_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage';
const REFRESH_URL = 'https://api2.cursor.sh/oauth/token';
const SECRET = 'eyJhbGciOiJub25lIn0.eyJlbWFpbCI6InRlc3RlckBleGFtcGxlLnRlc3QifQ.sig';

function setupHome(): { root: string; home: string; cache: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-cursor-'));
  dirs.push(root);
  process.env.HOME = root;
  process.env.XDG_CONFIG_HOME = path.join(root, '.config');
  const home = path.join(root, '.cursor');
  fs.mkdirSync(home, { recursive: true });
  return { root, home, cache: path.join(root, 'cache') };
}

function writeAuth(home: string, value: unknown): string {
  const file = path.join(home, 'auth.json');
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

function jwtWith(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `eyJhbGciOiJub25lIn0.${body}.sig`;
}

function writeStateDb(tokens: {
  accessToken: string;
  refreshToken?: string;
  email?: string;
  plan?: string;
}): string {
  const dbPath = path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'),
    'Cursor',
    'User',
    'globalStorage',
    'state.vscdb',
  );
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
  const insert = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)');
  insert.run('cursorAuth/accessToken', tokens.accessToken);
  if (tokens.refreshToken) insert.run('cursorAuth/refreshToken', tokens.refreshToken);
  if (tokens.email) insert.run('cursorAuth/cachedEmail', tokens.email);
  if (tokens.plan) insert.run('cursorAuth/stripeMembershipType', tokens.plan);
  db.close();
  return dbPath;
}

function writeIdeValue(dbPath: string, key: string, value: string): void {
  const db = new DatabaseSync(dbPath);
  db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)').run(key, value);
  db.close();
}

function usagePayload(): unknown {
  return {
    membershipType: 'ultra',
    billingCycleEnd: '2026-09-01T00:00:00.000Z',
    planUsage: {
      autoPercentUsed: 1,
      apiPercentUsed: 0,
    },
  };
}

describe('cursorAdapter', () => {
  it('binds env and login argv to cursor-agent with a file credential store', () => {
    const { home } = setupHome();
    expect(cursorAdapter.env(home)).toEqual({
      CURSOR_CONFIG_DIR: home,
      AGENT_CLI_CREDENTIAL_STORE: 'file',
      XDG_CONFIG_HOME: home,
    });
    expect(cursorAdapter.loginArgv()).toEqual(['cursor-agent', 'login']);
    expect(cursorAdapter.loginCommand(home)).toContain('cursor-agent login');
    expect(cursorAdapter.loginCommand(home)).toContain(`CURSOR_CONFIG_DIR=${home}`);
    expect(cursorAdapter.loginCommand(home)).toContain(`XDG_CONFIG_HOME=${home}`);
  });

  it('treats auth.json as credentials and reads identity from a JWT', () => {
    const { home } = setupHome();
    expect(cursorAdapter.hasCredentials(home)).toBe(false);
    writeAuth(home, { accessToken: SECRET, refreshToken: 'refresh-secret' });
    expect(cursorAdapter.hasCredentials(home)).toBe(true);
    expect(cursorAdapter.detectIdentity(home)).toEqual({
      account: 'tester@example.test',
      organization: null,
      plan: null,
    });
  });

  it('treats the Linux file-store path cursor/auth.json as credentials', () => {
    const { home } = setupHome();
    const nested = path.join(home, 'cursor');
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, 'auth.json'), JSON.stringify({ accessToken: SECRET }));
    expect(cursorAdapter.hasCredentials(home)).toBe(true);
    expect(cursorAdapter.detectIdentity(home)?.account).toBe('tester@example.test');
  });

  it('ignores the IDE database for a non-default home', () => {
    const { root } = setupHome();
    writeStateDb({ accessToken: SECRET, email: 'ide@example.test' });
    const other = path.join(root, 'managed');
    fs.mkdirSync(other);
    expect(cursorAdapter.hasCredentials(other)).toBe(false);
    expect(cursorAdapter.detectIdentity(other)).toBeNull();
  });

  it('falls back to the IDE state database for the default home', () => {
    const { home } = setupHome();
    writeStateDb({
      accessToken: SECRET,
      refreshToken: 'ide-refresh',
      email: 'ide@example.test',
      plan: 'ultra',
    });
    expect(cursorAdapter.hasCredentials(home)).toBe(true);
    expect(cursorAdapter.detectIdentity(home)?.account).toBe('tester@example.test');
    expect(cursorAdapter.detectIdentity(home)?.plan).toBe('ultra');
  });

  it('still uses the IDE fallback when ~/.cursor is a symlink', () => {
    const { root } = setupHome();
    const real = path.join(root, 'real-home');
    fs.mkdirSync(real);
    fs.rmSync(path.join(root, '.cursor'), { recursive: true, force: true });
    fs.symlinkSync(real, path.join(root, '.cursor'));
    writeStateDb({ accessToken: SECRET, email: 'ide@example.test', plan: 'pro' });
    expect(cursorAdapter.hasCredentials(path.join(root, '.cursor'))).toBe(true);
  });

  it('does not treat a symlink to a different directory as the default home', () => {
    const { root } = setupHome();
    writeStateDb({ accessToken: SECRET, email: 'ide@example.test' });
    const otherReal = path.join(root, 'other-real');
    const otherLink = path.join(root, 'other-link');
    fs.mkdirSync(otherReal);
    fs.symlinkSync(otherReal, otherLink);
    expect(cursorAdapter.hasCredentials(otherLink)).toBe(false);
  });

  it('does not give a managed home the IDE fallback just because it symlinks at ~/.cursor', () => {
    const { root, home } = setupHome();
    writeStateDb({ accessToken: SECRET, email: 'ide@example.test' });
    const managed = path.join(root, 'managed');
    fs.symlinkSync(home, managed);
    expect(cursorAdapter.hasCredentials(managed)).toBe(false);
    expect(cursorAdapter.hasCredentials(home)).toBe(true);
  });

  it('treats a missing IDE database on the default home as no credentials', async () => {
    const { home, cache } = setupHome();
    expect(cursorAdapter.hasCredentials(home)).toBe(false);
    const result = await cursorAdapter.collectUsage({
      home,
      cacheDir: cache,
      allowNetwork: true,
      now,
      fetchImpl: async () => {
        throw new Error('network should not run');
      },
    });
    expect(result.failureKind).toBe('auth');
    expect(result.windows).toEqual([]);
  });

  it('collects usage with the IDE token for the default home', async () => {
    const { home, cache } = setupHome();
    writeStateDb({ accessToken: 'ide-access', refreshToken: 'ide-refresh' });
    const result = await cursorAdapter.collectUsage({
      home,
      cacheDir: cache,
      allowNetwork: true,
      now,
      fetchImpl: async (_url, init) => {
        const headers = init?.headers as Record<string, string>;
        expect(headers.Authorization).toBe('Bearer ide-access');
        return new Response(JSON.stringify(usagePayload()), { status: 200 });
      },
    });
    expect(result.cacheStatus).toBe('live');
    expect(result.windows[0]?.id).toBe('cursor_models');
  });

  it('serves cooldown without fetching, and force skips it', async () => {
    const { home, cache } = setupHome();
    writeAuth(home, { accessToken: 'access-secret' });
    fs.utimesSync(path.join(home, 'auth.json'), new Date(now - 120_000), new Date(now - 120_000));
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(
      path.join(cache, 'cursor-usage.json'),
      JSON.stringify({
        updatedAt: new Date(now - 6 * 60_000).toISOString(),
        usage: usagePayload(),
        lastErrorAt: new Date(now - 30_000).toISOString(),
        lastErrorReason: 'Cursor usage endpoint returned HTTP 500',
      }),
    );
    const cooled = await cursorAdapter.collectUsage({
      home,
      cacheDir: cache,
      allowNetwork: true,
      now,
      fetchImpl: async () => {
        throw new Error('cooldown must not fetch');
      },
    });
    expect(cooled.cacheStatus).toBe('cooldown');
    expect(cooled.windows[0]?.id).toBe('cursor_models');

    const forced = await cursorAdapter.collectUsage({
      home,
      cacheDir: cache,
      allowNetwork: true,
      force: true,
      now,
      fetchImpl: async () => new Response(JSON.stringify(usagePayload()), { status: 200 }),
    });
    expect(forced.cacheStatus).toBe('live');
  });

  it('posts the pinned Connect usage RPC', async () => {
    const { home, cache } = setupHome();
    writeAuth(home, { accessToken: 'access-secret', refreshToken: 'refresh-secret' });
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const result = await cursorAdapter.collectUsage({
      home,
      cacheDir: cache,
      allowNetwork: true,
      now,
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        return new Response(JSON.stringify(usagePayload()), { status: 200 });
      },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(USAGE_URL);
    expect(requests[0]?.init?.method).toBe('POST');
    expect(requests[0]?.init?.body).toBe('{}');
    const headers = requests[0]?.init?.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Connect-Protocol-Version']).toBe('1');
    expect(headers.Authorization).toBe('Bearer access-secret');
    expect(result.cacheStatus).toBe('live');
    expect(result.planType).toBe('ultra');
    expect(result.windows).toEqual([
      {
        id: 'cursor_models',
        label: 'Cursor Models',
        usedPercent: 1,
        remainingPercent: 99,
        resetAt: '2026-09-01T00:00:00.000Z',
      },
      {
        id: 'other_models',
        label: 'Other Models',
        usedPercent: 0,
        remainingPercent: 100,
        resetAt: '2026-09-01T00:00:00.000Z',
      },
    ]);
  });

  it('prefers explicit pool fields over auto/api percents', () => {
    expect(
      cursorWindows(
        {
          billingCycleEnd: '2026-09-01T00:00:00.000Z',
          planUsage: {
            cursorModelsPercentUsed: 12,
            otherModelsPercentUsed: 34,
            autoPercentUsed: 1,
            apiPercentUsed: 2,
          },
        },
        now,
      ),
    ).toEqual([
      expect.objectContaining({ id: 'cursor_models', usedPercent: 12 }),
      expect.objectContaining({ id: 'other_models', usedPercent: 34 }),
    ]);
  });

  it('keeps fractional pool percents from the usage payload', () => {
    const windows = cursorWindows(
      {
        billingCycleEnd: '2026-09-01T00:00:00.000Z',
        planUsage: { autoPercentUsed: 0.4555, apiPercentUsed: 0 },
      },
      now,
    );
    expect(windows[0]).toEqual(
      expect.objectContaining({ id: 'cursor_models', usedPercent: 0.4555 }),
    );
    expect(windows[0]?.remainingPercent).toBeCloseTo(99.5445, 4);
    expect(windows[1]).toEqual(
      expect.objectContaining({ id: 'other_models', usedPercent: 0, remainingPercent: 100 }),
    );
  });

  it('returns an error snapshot when the payload has no pool percents', async () => {
    const { home, cache } = setupHome();
    writeAuth(home, { accessToken: 'access-secret' });
    const result = await cursorAdapter.collectUsage({
      home,
      cacheDir: cache,
      allowNetwork: true,
      now,
      fetchImpl: async () =>
        new Response(JSON.stringify({ membershipType: 'ultra' }), { status: 200 }),
    });
    expect(result.cacheStatus).toBe('error');
    expect(result.windows).toEqual([]);
  });

  it('refreshes in memory on 401 and does not write auth.json', async () => {
    const { home, cache } = setupHome();
    const authFile = writeAuth(home, {
      accessToken: 'stale-access',
      refreshToken: 'refresh-secret',
    });
    const before = fs.readFileSync(authFile, 'utf8');
    const urls: string[] = [];
    const result = await cursorAdapter.collectUsage({
      home,
      cacheDir: cache,
      allowNetwork: true,
      now,
      fetchImpl: async (url, init) => {
        urls.push(String(url));
        if (String(url) === USAGE_URL) {
          const headers = init?.headers as Record<string, string>;
          if (headers.Authorization === 'Bearer stale-access') {
            return new Response('nope', { status: 401 });
          }
          expect(headers.Authorization).toBe('Bearer rotated-access');
          return new Response(JSON.stringify(usagePayload()), { status: 200 });
        }
        expect(String(url)).toBe(REFRESH_URL);
        expect(init?.body).toContain('refresh-secret');
        return new Response(JSON.stringify({ access_token: 'rotated-access' }), { status: 200 });
      },
    });
    expect(result.cacheStatus).toBe('live');
    expect(urls).toEqual([USAGE_URL, REFRESH_URL, USAGE_URL]);
    expect(fs.readFileSync(authFile, 'utf8')).toBe(before);

    const later: string[] = [];
    const second = await cursorAdapter.collectUsage({
      home,
      cacheDir: cache,
      allowNetwork: true,
      force: true,
      now: now + 1,
      fetchImpl: async (url, init) => {
        later.push(String(url));
        const headers = init?.headers as Record<string, string>;
        expect(headers.Authorization).toBe('Bearer rotated-access');
        return new Response(JSON.stringify(usagePayload()), { status: 200 });
      },
    });
    expect(second.cacheStatus).toBe('live');
    expect(later).toEqual([USAGE_URL]);
    expect(fs.readFileSync(authFile, 'utf8')).toBe(before);
  });

  it('forgets refreshed tokens once auth.json is deleted', async () => {
    const { home, cache } = setupHome();
    const authFile = writeAuth(home, {
      accessToken: 'stale-access',
      refreshToken: 'refresh-secret',
    });
    await cursorAdapter.collectUsage({
      home,
      cacheDir: cache,
      allowNetwork: true,
      now,
      fetchImpl: async (url, init) => {
        if (String(url) === REFRESH_URL) {
          return new Response(JSON.stringify({ access_token: 'rotated-access' }), { status: 200 });
        }
        const headers = init?.headers as Record<string, string>;
        if (headers.Authorization === 'Bearer stale-access') {
          return new Response('nope', { status: 401 });
        }
        return new Response(JSON.stringify(usagePayload()), { status: 200 });
      },
    });
    expect(cursorAdapter.hasCredentials(home)).toBe(true);
    fs.rmSync(authFile);
    expect(cursorAdapter.hasCredentials(home)).toBe(false);
  });

  it('drops refreshed tokens when the auth file that seeded them is deleted, leftover sibling or not', async () => {
    const { home, cache } = setupHome();
    const authFile = writeAuth(home, {
      accessToken: 'stale-access',
      refreshToken: 'refresh-secret',
    });
    fs.mkdirSync(path.join(home, 'cursor'));
    fs.writeFileSync(
      path.join(home, 'cursor', 'auth.json'),
      JSON.stringify({ accessToken: 'leftover-access' }),
    );
    await cursorAdapter.collectUsage({
      home,
      cacheDir: cache,
      allowNetwork: true,
      now,
      fetchImpl: async (url, init) => {
        if (String(url) === REFRESH_URL) {
          return new Response(JSON.stringify({ access_token: 'rotated-access' }), { status: 200 });
        }
        const headers = init?.headers as Record<string, string>;
        if (headers.Authorization === 'Bearer stale-access') {
          return new Response('nope', { status: 401 });
        }
        return new Response(JSON.stringify(usagePayload()), { status: 200 });
      },
    });

    fs.rmSync(authFile);
    const used: string[] = [];
    await cursorAdapter.collectUsage({
      home,
      cacheDir: cache,
      allowNetwork: true,
      force: true,
      now: now + 1,
      fetchImpl: async (_url, init) => {
        used.push((init?.headers as Record<string, string>).Authorization);
        return new Response(JSON.stringify(usagePayload()), { status: 200 });
      },
    });
    expect(used).toEqual(['Bearer leftover-access']);
  });

  it('keeps refreshed IDE tokens across unrelated state.vscdb writes', async () => {
    const { home, cache } = setupHome();
    const dbPath = writeStateDb({ accessToken: 'stale-access', refreshToken: 'refresh-secret' });
    await cursorAdapter.collectUsage({
      home,
      cacheDir: cache,
      allowNetwork: true,
      now,
      fetchImpl: async (url, init) => {
        if (String(url) === REFRESH_URL) {
          return new Response(JSON.stringify({ access_token: 'rotated-access' }), { status: 200 });
        }
        const headers = init?.headers as Record<string, string>;
        if (headers.Authorization === 'Bearer stale-access') {
          return new Response('nope', { status: 401 });
        }
        return new Response(JSON.stringify(usagePayload()), { status: 200 });
      },
    });

    writeIdeValue(dbPath, 'someOtherSetting', 'changed');
    const used: string[] = [];
    const collect = async () =>
      cursorAdapter.collectUsage({
        home,
        cacheDir: cache,
        allowNetwork: true,
        force: true,
        now: now + 1,
        fetchImpl: async (_url, init) => {
          used.push((init?.headers as Record<string, string>).Authorization);
          return new Response(JSON.stringify(usagePayload()), { status: 200 });
        },
      });
    await collect();

    // A new IDE login does replace them.
    writeIdeValue(dbPath, 'cursorAuth/accessToken', 'ide-relogin');
    await collect();
    expect(used).toEqual(['Bearer rotated-access', 'Bearer ide-relogin']);
  });

  it('does not mix IDE identity into a home that already has auth.json', () => {
    const { home } = setupHome();
    writeAuth(home, { accessToken: 'opaque-not-a-jwt', refreshToken: 'refresh-secret' });
    writeStateDb({ accessToken: SECRET, email: 'ide@example.test', plan: 'ultra' });
    expect(cursorAdapter.detectIdentity(home)).toBeNull();
  });

  it('does not use the JWT subject as the account name', () => {
    const { home } = setupHome();
    writeAuth(home, { accessToken: jwtWith({ sub: 'auth0|user_noemail' }) });
    expect(cursorAdapter.detectIdentity(home)).toBeNull();
  });

  it('reads email and team from cli-config when the JWT has no email', () => {
    const { home } = setupHome();
    writeAuth(home, { accessToken: jwtWith({ sub: 'auth0|user_noemail' }) });
    fs.writeFileSync(
      path.join(home, 'cli-config.json'),
      JSON.stringify({
        authInfo: { email: 'cli@example.test', teamName: 'Acme' },
      }),
    );
    writeStateDb({ accessToken: SECRET, email: 'ide@example.test', plan: 'ultra' });
    expect(cursorAdapter.detectIdentity(home)).toEqual({
      account: 'cli@example.test',
      organization: 'Acme',
      plan: null,
    });
  });

  it('uses the IDE cached email for the default home, not a leftover cli-config account', () => {
    const { home } = setupHome();
    fs.writeFileSync(
      path.join(home, 'cli-config.json'),
      JSON.stringify({ authInfo: { email: 'cli@example.test', teamName: 'Wrong Team' } }),
    );
    writeStateDb({ accessToken: 'opaque-not-a-jwt', email: 'ide@example.test', plan: 'ultra' });
    expect(cursorAdapter.detectIdentity(home)).toEqual({
      account: 'ide@example.test',
      organization: null,
      plan: 'ultra',
    });
  });

  it('does not write the IDE database after an in-memory refresh', async () => {
    const { home, cache } = setupHome();
    const dbPath = writeStateDb({ accessToken: 'stale-access', refreshToken: 'refresh-secret' });
    const before = fs.readFileSync(dbPath);
    await cursorAdapter.collectUsage({
      home,
      cacheDir: cache,
      allowNetwork: true,
      now,
      fetchImpl: async (url, init) => {
        if (String(url) === USAGE_URL) {
          const headers = init?.headers as Record<string, string>;
          if (headers.Authorization === 'Bearer stale-access') {
            return new Response('nope', { status: 401 });
          }
          return new Response(JSON.stringify(usagePayload()), { status: 200 });
        }
        return new Response(JSON.stringify({ access_token: 'rotated-access' }), { status: 200 });
      },
    });
    expect(fs.readFileSync(dbPath)).toEqual(before);
  });

  it('classifies a 401 after a failed refresh as auth', async () => {
    const { home, cache } = setupHome();
    writeAuth(home, { accessToken: 'stale-access', refreshToken: 'refresh-secret' });
    const result = await cursorAdapter.collectUsage({
      home,
      cacheDir: cache,
      allowNetwork: true,
      now,
      fetchImpl: async (url) => {
        if (String(url) === REFRESH_URL) {
          return new Response(JSON.stringify({ shouldLogout: true, access_token: '' }), {
            status: 200,
          });
        }
        return new Response('nope', { status: 401 });
      },
    });
    expect(result.failureKind).toBe('auth');
    expect(result.error).not.toMatch(/stale-access|refresh-secret|Bearer/);
  });

  it('does not put tokens from thrown fetch errors into the snapshot', async () => {
    const { home, cache } = setupHome();
    writeAuth(home, { accessToken: SECRET });
    const result = await cursorAdapter.collectUsage({
      home,
      cacheDir: cache,
      allowNetwork: true,
      now,
      fetchImpl: async () => {
        throw new Error(`GET ${USAGE_URL}?access_token=${SECRET} Authorization: Bearer ${SECRET}`);
      },
    });
    expect(result.error).toContain('[redacted]');
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('keeps a cookie and a bare JWT out of error text', async () => {
    const { home, cache } = setupHome();
    writeAuth(home, { accessToken: SECRET });
    const result = await cursorAdapter.collectUsage({
      home,
      cacheDir: cache,
      allowNetwork: true,
      now,
      fetchImpl: async () => {
        throw new Error(`WorkosCursorSessionToken=${SECRET}; auth=${SECRET}`);
      },
    });
    expect(result.error).toBe('WorkosCursorSessionToken=[redacted]; auth=[redacted]');
  });

  it('treats a network error carrying a token as transient and still serves the cache', async () => {
    const { home, cache } = setupHome();
    writeAuth(home, { accessToken: SECRET });
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(
      path.join(cache, 'cursor-usage.json'),
      JSON.stringify({
        updatedAt: new Date(now - 10 * 60_000).toISOString(),
        usage: usagePayload(),
      }),
    );
    const result = await cursorAdapter.collectUsage({
      home,
      cacheDir: cache,
      allowNetwork: true,
      now,
      fetchImpl: async () => {
        throw new Error(`connect ECONNREFUSED api2.cursor.sh (Bearer ${SECRET})`);
      },
    });
    expect(result.failureKind).toBe('error');
    expect(result.cacheStatus).toBe('stale-cache');
    expect(result.windows[0]?.id).toBe('cursor_models');
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('does not serve fresh cache once the credentials are gone', async () => {
    const { home, cache } = setupHome();
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(
      path.join(cache, 'cursor-usage.json'),
      JSON.stringify({ updatedAt: new Date(now - 60_000).toISOString(), usage: usagePayload() }),
    );
    const result = await cursorAdapter.collectUsage({
      home,
      cacheDir: cache,
      allowNetwork: true,
      now,
      fetchImpl: async () => {
        throw new Error('network should not run');
      },
    });
    expect(result.failureKind).toBe('auth');
    expect(result.windows).toEqual([]);
  });

  it('serves cache when network is disabled', async () => {
    const { home, cache } = setupHome();
    writeAuth(home, { accessToken: 'access-secret' });
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(
      path.join(cache, 'cursor-usage.json'),
      JSON.stringify({ updatedAt: new Date(now - 60_000).toISOString(), usage: usagePayload() }),
    );
    const result = await cursorAdapter.collectUsage({
      home,
      cacheDir: cache,
      allowNetwork: false,
      now,
      fetchImpl: async () => {
        throw new Error('network should not run');
      },
    });
    expect(result.cacheStatus).toBe('cache');
    expect(result.windows[0]?.id).toBe('cursor_models');
  });
});
