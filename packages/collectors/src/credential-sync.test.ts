import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CredentialBundle } from '@apm/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeAdapter } from './adapters/claude.js';
import { codexAdapter } from './adapters/codex.js';
import { cursorAdapter } from './adapters/cursor.js';
import { stablePayloadKey } from './credential-sync.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function home(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-credsync-'));
  dirs.push(dir);
  return dir;
}

function writeFileAt(file: string, value: unknown, mtimeMs: number): void {
  fs.writeFileSync(file, JSON.stringify(value));
  fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
}

const T0 = Date.parse('2026-08-20T10:00:00.000Z');
const T1 = Date.parse('2026-08-20T11:00:00.000Z');
const T2 = Date.parse('2026-08-20T12:00:00.000Z');
const T3 = Date.parse('2026-08-20T13:00:00.000Z');

function claudeBundle(token: string, rotatedAtMs: number): CredentialBundle {
  return {
    provider: 'claude',
    rotatedAt: new Date(rotatedAtMs).toISOString(),
    payload: { claudeAiOauth: { accessToken: token, refreshToken: `${token}-refresh` } },
  };
}

describe('credential sync (claude)', () => {
  const sync = claudeAdapter.credentialSync!;

  it('reads the claudeAiOauth subset with the file mtime as rotatedAt', async () => {
    const dir = home();
    writeFileAt(
      path.join(dir, '.credentials.json'),
      { claudeAiOauth: { accessToken: 'a1' }, unrelated: { keep: true } },
      T1,
    );
    const bundle = await sync.readBundle(dir);
    expect(bundle).toEqual({
      provider: 'claude',
      rotatedAt: new Date(T1).toISOString(),
      payload: { claudeAiOauth: { accessToken: 'a1' } },
    });
  });

  it('returns null without a credential file or without an oauth object', async () => {
    const empty = home();
    expect(await sync.readBundle(empty)).toBeNull();
    const wrongShape = home();
    writeFileAt(path.join(wrongShape, '.credentials.json'), { somethingElse: 1 }, T1);
    expect(await sync.readBundle(wrongShape)).toBeNull();
  });

  it('if-newer: applies a newer bundle, preserves unrelated fields, sets the mtime', async () => {
    const dir = home();
    const file = path.join(dir, '.credentials.json');
    writeFileAt(file, { claudeAiOauth: { accessToken: 'old' }, unrelated: { keep: true } }, T1);

    expect(await sync.writeBundle(dir, claudeBundle('new', T2), 'if-newer')).toBe('applied');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      unrelated: { keep: true },
      claudeAiOauth: { accessToken: 'new', refreshToken: 'new-refresh' },
    });
    expect(Math.trunc(fs.statSync(file).mtimeMs)).toBe(T2);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('if-newer: rejects equal and older bundles without touching the file', async () => {
    const dir = home();
    const file = path.join(dir, '.credentials.json');
    writeFileAt(file, { claudeAiOauth: { accessToken: 'current' } }, T1);
    const before = fs.readFileSync(file, 'utf8');

    expect(await sync.writeBundle(dir, claudeBundle('same-age', T1), 'if-newer')).toBe('stale');
    expect(await sync.writeBundle(dir, claudeBundle('older', T0), 'if-newer')).toBe('stale');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(Math.trunc(fs.statSync(file).mtimeMs)).toBe(T1);
  });

  it('if-newer: applies to a home without a credential file (first replica pull)', async () => {
    const dir = home();
    expect(await sync.writeBundle(dir, claudeBundle('first', T1), 'if-newer')).toBe('applied');
    const written = JSON.parse(fs.readFileSync(path.join(dir, '.credentials.json'), 'utf8'));
    expect(written.claudeAiOauth.accessToken).toBe('first');
  });

  it('if-differs: applies an older-stamped bundle when the payload differs, not when equal', async () => {
    const dir = home();
    const file = path.join(dir, '.credentials.json');
    writeFileAt(file, { claudeAiOauth: { accessToken: 'failed-local' } }, T2);

    // Older timestamp, different payload: pull recovery must apply it.
    expect(await sync.writeBundle(dir, claudeBundle('valid-older', T1), 'if-differs')).toBe(
      'applied',
    );
    expect(Math.trunc(fs.statSync(file).mtimeMs)).toBe(T1);
    // Identical payload: nothing to gain, no write.
    expect(await sync.writeBundle(dir, claudeBundle('valid-older', T0), 'if-differs')).toBe(
      'stale',
    );
    expect(Math.trunc(fs.statSync(file).mtimeMs)).toBe(T1);
  });

  it('honors the expectPayload guard: applies only while the on-disk payload matches', async () => {
    const dir = home();
    const file = path.join(dir, '.credentials.json');
    writeFileAt(file, { claudeAiOauth: { accessToken: 'failed-local' } }, T1);
    const failedPayload = { claudeAiOauth: { accessToken: 'failed-local' } };

    // The on-disk payload rotated after the guard value was captured: stale.
    writeFileAt(file, { claudeAiOauth: { accessToken: 'rotated-meanwhile' } }, T2);
    expect(
      await sync.writeBundle(dir, claudeBundle('candidate', T3), 'if-differs', {
        expectPayload: failedPayload,
      }),
    ).toBe('stale');

    // Matching expectation applies; a null expectation means "no file yet".
    expect(
      await sync.writeBundle(dir, claudeBundle('candidate', T3), 'if-differs', {
        expectPayload: { claudeAiOauth: { accessToken: 'rotated-meanwhile' } },
      }),
    ).toBe('applied');
    const empty = home();
    expect(
      await sync.writeBundle(empty, claudeBundle('first', T1), 'if-differs', {
        expectPayload: null,
      }),
    ).toBe('applied');
    expect(
      await sync.writeBundle(home(), claudeBundle('first', T1), 'if-differs', {
        expectPayload: failedPayload,
      }),
    ).toBe('stale');
  });

  it('rejects a bundle payload without a usable oauth object', async () => {
    const dir = home();
    await expect(
      sync.writeBundle(
        dir,
        { provider: 'claude', rotatedAt: new Date(T1).toISOString(), payload: { nope: 1 } },
        'if-newer',
      ),
    ).rejects.toThrow('Unusable claude credential bundle payload');
  });

  it('re-applying a pushed bundle round-trips to stale (no echo between machines)', async () => {
    const dir = home();
    expect(await sync.writeBundle(dir, claudeBundle('t', T1), 'if-newer')).toBe('applied');
    const echoed = await sync.readBundle(dir);
    expect(echoed?.rotatedAt).toBe(new Date(T1).toISOString());
    expect(await sync.writeBundle(dir, echoed!, 'if-newer')).toBe('stale');
  });
});

describe('credential sync (codex)', () => {
  const sync = codexAdapter.credentialSync!;

  it('round-trips the tokens subset and preserves machine-local fields on write', async () => {
    const dir = home();
    const file = path.join(dir, 'auth.json');
    writeFileAt(
      file,
      {
        auth_mode: 'chatgpt',
        OPENAI_API_KEY: 'machine-local-key',
        tokens: { access_token: 'old', refresh_token: 'old-r' },
        last_refresh: new Date(T0).toISOString(),
      },
      T1,
    );

    const bundle = await sync.readBundle(dir);
    expect(bundle).toEqual({
      provider: 'codex',
      rotatedAt: new Date(T1).toISOString(),
      payload: {
        auth_mode: 'chatgpt',
        tokens: { access_token: 'old', refresh_token: 'old-r' },
        last_refresh: new Date(T0).toISOString(),
      },
    });

    const rotated: CredentialBundle = {
      provider: 'codex',
      rotatedAt: new Date(T2).toISOString(),
      payload: {
        auth_mode: 'chatgpt',
        tokens: { access_token: 'new', refresh_token: 'new-r' },
        last_refresh: new Date(T2).toISOString(),
      },
    };
    expect(await sync.writeBundle(dir, rotated, 'if-newer')).toBe('applied');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: 'machine-local-key',
      tokens: { access_token: 'new', refresh_token: 'new-r' },
      last_refresh: new Date(T2).toISOString(),
    });
    expect(Math.trunc(fs.statSync(file).mtimeMs)).toBe(T2);
  });

  it('normalizes legacy token files to explicit ChatGPT auth on a fresh home', async () => {
    const source = home();
    writeFileAt(
      path.join(source, 'auth.json'),
      { tokens: { access_token: 'old', refresh_token: 'old-r' } },
      T1,
    );
    const bundle = await sync.readBundle(source);
    expect(bundle?.payload).toMatchObject({ auth_mode: 'chatgpt' });

    const target = home();
    expect(await sync.writeBundle(target, bundle!, 'if-newer')).toBe('applied');
    expect(JSON.parse(fs.readFileSync(path.join(target, 'auth.json'), 'utf8'))).toEqual({
      auth_mode: 'chatgpt',
      tokens: { access_token: 'old', refresh_token: 'old-r' },
    });
  });
});

describe('credential sync capability', () => {
  it('cursor has none — excluded from sync by construction', () => {
    expect(cursorAdapter.credentialSync).toBeUndefined();
    expect(claudeAdapter.credentialSync).toBeDefined();
    expect(codexAdapter.credentialSync).toBeDefined();
  });
});

describe('stablePayloadKey', () => {
  it('is key-order independent and value sensitive', () => {
    expect(stablePayloadKey({ a: 1, b: { d: 2, c: [3] } })).toBe(
      stablePayloadKey({ b: { c: [3], d: 2 }, a: 1 }),
    );
    expect(stablePayloadKey({ a: 1 })).not.toBe(stablePayloadKey({ a: 2 }));
  });
});
