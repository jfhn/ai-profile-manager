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
import { profileShimDirectory } from '../core/profilePaths.js';
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

const CURSOR_PROFILE: Profile = {
  ...PROFILE,
  id: 'profile-cursor',
  provider: 'cursor',
  label: 'cursor work',
  home: '/tmp/apm-cursor-home',
};

function profiles(): Pick<ProfileService, 'list' | 'envFor'> {
  return {
    list: () => [PROFILE, CODEX_PROFILE, CURSOR_PROFILE],
    envFor: (id) => {
      if (id === PROFILE.id) return { session: { CLAUDE_CONFIG_DIR: PROFILE.home }, appOnly: null };
      if (id === CODEX_PROFILE.id) {
        return { session: { CODEX_HOME: CODEX_PROFILE.home }, appOnly: null };
      }
      if (id === CURSOR_PROFILE.id) {
        return {
          session: {
            CURSOR_CONFIG_DIR: CURSOR_PROFILE.home,
            AGENT_CLI_CREDENTIAL_STORE: 'file',
          },
          appOnly: { app: 'cursor-agent', env: { XDG_CONFIG_HOME: CURSOR_PROFILE.home } },
        };
      }
      return { session: {}, appOnly: null };
    },
  };
}

describe('local transport', () => {
  let transport: TargetTransport;
  let dir: string;
  let shimsDir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-local-'));
    shimsDir = path.join(dir, 'shims');
    transport = createLocalTransport({ profiles: profiles(), shimsDir });
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

    // A provider that binds through its own variables needs no shim.
    const withPath = await transport.exec({
      argv: ['sh', '-c', 'printf %s "$PATH"'],
      profileIds: [PROFILE.id],
      cwd: dir,
    });
    expect(withPath.stdout).toBe(process.env.PATH);
    expect(fs.existsSync(shimsDir)).toBe(false);
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

  it('drops inherited CURSOR_API_KEY when a Cursor profile is bound', async () => {
    const previous = process.env.CURSOR_API_KEY;
    process.env.CURSOR_API_KEY = 'inherited-secret';
    try {
      const result = await transport.exec({
        argv: ['sh', '-c', 'printf %s "${CURSOR_API_KEY+set}:$CURSOR_CONFIG_DIR"'],
        profileIds: [CURSOR_PROFILE.id],
        cwd: dir,
      });
      expect(result.stdout).toBe(`:${CURSOR_PROFILE.home}`);
    } finally {
      if (previous === undefined) delete process.env.CURSOR_API_KEY;
      else process.env.CURSOR_API_KEY = previous;
    }
  });

  it('keeps a Cursor binding out of the session and reaches cursor-agent through a shim', async () => {
    const binDir = path.join(dir, 'bin');
    fs.mkdirSync(binDir);
    fs.writeFileSync(
      path.join(binDir, 'cursor-agent'),
      '#!/bin/sh\nprintf \'%s\\n\' "$XDG_CONFIG_HOME" "$PATH" "$CURSOR_CONFIG_DIR"\n',
      { mode: 0o755 },
    );

    const result = await transport.exec({
      argv: ['sh', '-c', `printf '%s\\n' "$XDG_CONFIG_HOME" "$CURSOR_CONFIG_DIR"; cursor-agent`],
      profileIds: [CURSOR_PROFILE.id],
      env: { PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}` },
      cwd: dir,
    });

    const [sessionXdg, sessionConfigDir, agentXdg, agentPath, agentConfigDir] =
      result.stdout.split('\n');
    expect(sessionXdg).not.toBe(CURSOR_PROFILE.home);
    expect(sessionConfigDir).toBe(CURSOR_PROFILE.home);
    expect(agentXdg).toBe(CURSOR_PROFILE.home);
    expect(agentConfigDir).toBe(CURSOR_PROFILE.home);
    // The shim dropped its own directory, so cursor-agent ran the real binary.
    const shimDir = profileShimDirectory(shimsDir, CURSOR_PROFILE.id);
    expect(agentPath?.split(path.delimiter)).not.toContain(shimDir);
    expect(fs.statSync(path.join(shimDir, 'cursor-agent')).mode & 0o777).toBe(0o755);
  });

  it('gives cursor-agent itself the app-only vars without a shim', async () => {
    const agent = path.join(dir, 'cursor-agent');
    fs.writeFileSync(agent, '#!/bin/sh\nprintf \'%s\\n\' "$XDG_CONFIG_HOME" "$PATH"\n', {
      mode: 0o755,
    });

    const result = await transport.exec({
      argv: [agent],
      profileIds: [CURSOR_PROFILE.id],
      cwd: dir,
    });

    const [xdg, pathValue] = result.stdout.split('\n');
    expect(xdg).toBe(CURSOR_PROFILE.home);
    expect(pathValue).toBe(process.env.PATH);
    expect(fs.existsSync(shimsDir)).toBe(false);
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
