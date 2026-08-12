/**
 * Local-transport specifics: the things only the real machine can show —
 * profile env injection, cwd defaults and real signals.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LOCAL_TARGET_ID,
  TARGET_CAPABILITIES,
  type Profile,
  type TargetTransport,
} from '@apm/shared';
import type { ProfileService } from '../context.js';
import { createLocalTarget, createLocalTransport } from './local.js';

const PROFILE: Profile = {
  id: 'profile-1',
  provider: 'claude',
  label: 'work',
  home: '/tmp/apm-local-home',
  homeKind: 'external',
  identity: null,
  status: 'active',
  statusReason: null,
  enabled: true,
  createdAt: new Date().toISOString(),
};

const CODEX_PROFILE: Profile = {
  ...PROFILE,
  id: 'profile-2',
  provider: 'codex',
  label: 'codex work',
  home: '/tmp/apm-codex-home',
};

function profiles(): Pick<ProfileService, 'list' | 'envFor'> {
  return {
    list: () => [PROFILE, CODEX_PROFILE],
    envFor: (id) => {
      if (id === PROFILE.id) return { CLAUDE_CONFIG_DIR: PROFILE.home };
      if (id === CODEX_PROFILE.id) return { CODEX_HOME: CODEX_PROFILE.home };
      return {};
    },
  };
}

describe('local transport', () => {
  let transport: TargetTransport;
  let dir: string;

  beforeEach(() => {
    transport = createLocalTransport({ profiles: profiles() });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-local-'));
  });

  afterEach(async () => {
    await transport.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('describes this machine as an approved local target with every capability', () => {
    const target = createLocalTarget();
    expect(target.id).toBe(LOCAL_TARGET_ID);
    expect(target.kind).toBe('local');
    expect(target.approved).toBe(true);
    expect(target.capabilities).toEqual([...TARGET_CAPABILITIES]);
    expect(target.identity.fingerprint).toBeNull();
  });

  it('injects the named profile’s env on the target and lets spec env win', async () => {
    const bound = await transport.exec({
      argv: ['sh', '-c', 'printf %s "$CLAUDE_CONFIG_DIR"'],
      profileIds: [PROFILE.id],
      cwd: dir,
    });
    expect(bound.stdout).toBe(PROFILE.home);

    const overridden = await transport.exec({
      argv: ['sh', '-c', 'printf %s "$APM_TEST_VALUE"'],
      env: { APM_TEST_VALUE: 'from-spec' },
      cwd: dir,
    });
    expect(overridden.stdout).toBe('from-spec');

    const unbound = await transport.exec({
      argv: ['sh', '-c', 'printf %s "$CLAUDE_CONFIG_DIR"'],
      cwd: dir,
    });
    expect(unbound.stdout).toBe('');
  });

  it('merges every bound profile’s env — one per provider — into one process', async () => {
    const both = await transport.exec({
      argv: ['sh', '-c', 'printf %s:%s "$CLAUDE_CONFIG_DIR" "$CODEX_HOME"'],
      profileIds: [PROFILE.id, CODEX_PROFILE.id],
      cwd: dir,
    });
    expect(both.stdout).toBe(`${PROFILE.home}:${CODEX_PROFILE.home}`);

    // One binding leaves the other provider on the machine's default home.
    const codexOnly = await transport.exec({
      argv: ['sh', '-c', 'printf %s:%s "$CLAUDE_CONFIG_DIR" "$CODEX_HOME"'],
      profileIds: [CODEX_PROFILE.id],
      cwd: dir,
    });
    expect(codexOnly.stdout).toBe(`:${CODEX_PROFILE.home}`);
  });

  it('runs in the requested cwd and defaults to the home directory', async () => {
    const explicit = await transport.exec({ argv: ['pwd'], cwd: dir });
    expect(fs.realpathSync(explicit.stdout.trim())).toBe(fs.realpathSync(dir));

    const fallback = await transport.exec({ argv: ['pwd'] });
    expect(fs.realpathSync(fallback.stdout.trim())).toBe(fs.realpathSync(os.homedir()));
  });

  it('pipes stdin into the command', async () => {
    const result = await transport.exec({ argv: ['cat'], cwd: dir }, { stdin: 'piped-in' });
    expect(result.stdout).toBe('piped-in');
  });

  it('kills a command that outruns its timeout', async () => {
    await expect(
      transport.exec({ argv: ['sleep', '30'], cwd: dir }, { timeoutMs: 100 }),
    ).rejects.toMatchObject({ code: 'timeout', targetId: LOCAL_TARGET_ID });
  });

  it('refuses an empty argv', async () => {
    await expect(transport.exec({ argv: [] })).rejects.toMatchObject({ code: 'spawn-failed' });
  });

  it('delivers a real signal to a pty and reports it as the exit status', async () => {
    const handle = await transport.openPty({ argv: ['cat'], cols: 80, rows: 24, cwd: dir });
    const exits: Array<{ exitCode: number | null; signal: string | null }> = [];
    handle.onExit((status) => void exits.push(status));

    handle.signal('SIGTERM');
    await waitFor(() => exits.length === 1);
    expect(exits[0]).toEqual({ exitCode: null, signal: 'SIGTERM' });
  });

  it('takes a pty’s whole process group down with it', async () => {
    // A pty child is a session leader, so a server it spawned survives a kill
    // aimed at the child alone — and then holds its port with nobody watching.
    const handle = await transport.openPty({
      argv: ['sh', '-c', 'sleep 60 & echo $!; wait'],
      cols: 80,
      rows: 24,
      cwd: dir,
    });
    let output = '';
    handle.onData((data) => void (output += data));
    await waitFor(() => /\d/.test(output));
    const grandchild = Number(/(\d+)/.exec(output)?.[1]);
    expect(grandchild).toBeGreaterThan(1);
    expect(alive(grandchild)).toBe(true);

    await handle.close();
    await waitFor(() => !alive(grandchild));
    expect(alive(grandchild)).toBe(false);
  });
});

/** Signal 0 only checks existence; EPERM means it exists but is not ours. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for condition');
}
