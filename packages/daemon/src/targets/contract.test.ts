/**
 * The transport contract, run against every implementation we have: the real
 * local transport and the deterministic fake remote one. Anything asserted
 * here is what sessions and the CLI may rely on for any target.
 */
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isTransportError,
  type CommandSpec,
  type Profile,
  type PtyHandle,
  type PtySpec,
  type TargetTransport,
} from '@apm/shared';
import type { ProfileService } from '../context.js';
import { createLocalTransport } from './local.js';
import { createFakeRemoteTransport } from './test-support/fake-remote.js';

const PROFILE: Profile = {
  id: 'profile-1',
  provider: 'claude',
  label: 'work',
  home: '/tmp/apm-contract-home',
  homeKind: 'external',
  identity: null,
  status: 'active',
  statusReason: null,
  enabled: true,
  sync: null,
  createdAt: new Date().toISOString(),
};

/** What each implementation has to provide so one suite can drive both. */
interface Fixture {
  transport: TargetTransport;
  /** A command writing exactly `text` to stdout and exiting 0. */
  echo(text: string): CommandSpec;
  /** A command exiting with `code`. */
  exitWith(code: number): CommandSpec;
  /** A command the target does not have. */
  missingCommand(): CommandSpec;
  /** A valid command with a working directory that does not exist. */
  badCwd(): CommandSpec;
  /** An interactive process. */
  interactive(): PtySpec;
  /** Make that process produce `text` on its output. */
  produce(handle: PtyHandle, text: string): void;
  cleanup(): Promise<void>;
}

/** No fixture binds a profile that needs a shim, so this stays empty. */
const SHIMS_DIR = path.join(os.tmpdir(), 'apm-contract-shims');

function fakeProfiles(): Pick<ProfileService, 'list' | 'envFor'> {
  return {
    list: () => [PROFILE],
    envFor: (id) => ({
      session: id === PROFILE.id ? { CLAUDE_CONFIG_DIR: PROFILE.home } : {},
      appOnly: null,
    }),
  };
}

async function localFixture(): Promise<Fixture> {
  const transport = createLocalTransport({ profiles: fakeProfiles(), shimsDir: SHIMS_DIR });
  return {
    transport,
    echo: (text) => ({ argv: ['printf', '%s', text] }),
    exitWith: (code) => ({ argv: ['sh', '-c', `exit ${code}`] }),
    missingCommand: () => ({ argv: ['definitely-not-installed-xyz'] }),
    badCwd: () => ({ argv: ['pwd'], cwd: '/definitely/not/a/directory' }),
    interactive: () => ({ argv: ['cat'], cols: 80, rows: 24 }),
    produce: (handle, text) => handle.write(text),
    cleanup: async () => undefined,
  };
}

async function fakeRemoteFixture(): Promise<Fixture> {
  const transport = createFakeRemoteTransport({
    profiles: [
      {
        id: PROFILE.id,
        provider: PROFILE.provider,
        label: PROFILE.label,
        status: PROFILE.status,
        enabled: PROFILE.enabled,
      },
    ],
  });
  return {
    transport,
    echo(text) {
      const argv = ['printf', '%s', text];
      transport.scriptExec(argv, { stdout: text });
      return { argv };
    },
    exitWith(code) {
      const argv = ['sh', '-c', `exit ${code}`];
      transport.scriptExec(argv, { exitCode: code });
      return { argv };
    },
    missingCommand() {
      const argv = ['definitely-not-installed-xyz'];
      transport.scriptFailure(argv, 'command-not-found', `Command not found: ${argv[0]}`);
      return { argv };
    },
    badCwd() {
      const argv = ['pwd'];
      transport.scriptFailure(argv, 'cwd-not-found', 'Working directory does not exist');
      return { argv, cwd: '/definitely/not/a/directory' };
    },
    interactive: () => ({ argv: ['cat'], cols: 80, rows: 24 }),
    produce: (_handle, text) => transport.lastPty().emit(text),
    cleanup: async () => undefined,
  };
}

const IMPLEMENTATIONS: Array<{ name: string; create: () => Promise<Fixture> }> = [
  { name: 'local', create: localFixture },
  { name: 'fake remote', create: fakeRemoteFixture },
];

describe.each(IMPLEMENTATIONS)('transport contract ($name)', ({ create }) => {
  let fixture: Fixture;

  async function setup(): Promise<Fixture> {
    fixture = await create();
    return fixture;
  }

  afterEach(async () => {
    await fixture?.cleanup();
    await fixture?.transport.close();
  });

  it('answers supports() from its declared capabilities', async () => {
    const { transport } = await setup();
    for (const capability of transport.target.capabilities) {
      expect(transport.supports(capability)).toBe(true);
    }
    expect(transport.target.id).toBeTruthy();
    expect(await transport.probe()).toBe('online');
  });

  it('runs argv and returns stdout with a zero exit', async () => {
    const { transport, echo } = await setup();
    const result = await transport.exec(echo('hello-target'));
    expect(result.stdout).toBe('hello-target');
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
  });

  it('treats a non-zero exit as a result, not an error', async () => {
    const { transport, exitWith } = await setup();
    const result = await transport.exec(exitWith(3));
    expect(result.exitCode).toBe(3);
  });

  it('never lets argv reach a shell', async () => {
    const { transport, echo } = await setup();
    const payload = '$(touch /tmp/apm-should-not-exist); rm -rf ~; `whoami`';
    const result = await transport.exec(echo(payload));
    expect(result.stdout).toBe(payload);
  });

  it('rejects a command the target does not have', async () => {
    const { transport, missingCommand } = await setup();
    await expect(transport.exec(missingCommand())).rejects.toMatchObject({
      code: 'command-not-found',
    });
  });

  it('rejects a working directory that does not exist', async () => {
    const { transport, badCwd } = await setup();
    const error = await transport.exec(badCwd()).catch((thrown: unknown) => thrown);
    expect(isTransportError(error)).toBe(true);
    expect(error).toMatchObject({ code: 'cwd-not-found', targetId: transport.target.id });
  });

  it('streams pty output to every listener and stops on unsubscribe', async () => {
    const { transport, interactive, produce } = await setup();
    const handle = await transport.openPty(interactive());
    expect(handle.targetId).toBe(transport.target.id);

    let both = '';
    let only = '';
    const stop = handle.onData((data) => void (both += data));
    handle.onData((data) => void (only += data));

    produce(handle, 'first\n');
    await waitFor(() => both.includes('first') && only.includes('first'));

    stop();
    produce(handle, 'second\n');
    await waitFor(() => only.includes('second'));
    expect(both).not.toContain('second');

    await handle.close();
  });

  it('accepts resize and signals while the process lives', async () => {
    const { transport, interactive } = await setup();
    const handle = await transport.openPty(interactive());
    expect(() => handle.resize(120, 40)).not.toThrow();
    expect(() => handle.signal('SIGINT')).not.toThrow();
    await handle.close();
  });

  it('reports the exit status once and replays it to late listeners', async () => {
    const { transport, interactive } = await setup();
    const handle = await transport.openPty(interactive());
    const exits: Array<number | null> = [];
    handle.onExit((status) => void exits.push(status.exitCode));

    await handle.close();
    await waitFor(() => exits.length === 1);

    let late = 0;
    handle.onExit(() => void (late += 1));
    expect(late).toBe(1);

    // Everything is inert afterwards, including a second close.
    expect(() => handle.write('ignored')).not.toThrow();
    expect(() => handle.resize(10, 10)).not.toThrow();
    expect(() => handle.signal('SIGKILL')).not.toThrow();
    await handle.close();
    expect(exits).toHaveLength(1);
  });

  it('normalizes signal exits to a null exit code', async () => {
    const { transport, interactive } = await setup();
    const handle = await transport.openPty(interactive());
    let status: { exitCode: number | null; signal: string | null } | null = null;
    handle.onExit((next) => void (status = next));

    await handle.close();
    await waitFor(() => status !== null);
    expect(status?.signal).not.toBeNull();
    expect(status?.exitCode).toBeNull();
  });

  it('lists the target’s profiles without homes or credentials', async () => {
    const { transport } = await setup();
    const profiles = await transport.profiles();
    expect(profiles).toEqual([
      { id: 'profile-1', provider: 'claude', label: 'work', status: 'active', enabled: true },
    ]);
    for (const profile of profiles) {
      expect(Object.keys(profile)).not.toContain('home');
    }
  });
});

describe('credential sync over transports', () => {
  const sync = { id: '11111111-2222-4333-8444-555555555555', role: 'replica' as const };
  const bundle = (token: string, rotatedAt: string) => ({
    provider: 'claude' as const,
    rotatedAt,
    payload: { claudeAiOauth: { accessToken: token } },
  });

  it('the local transport neither advertises nor performs sync', async () => {
    const transport = createLocalTransport({ profiles: fakeProfiles(), shimsDir: SHIMS_DIR });
    expect(transport.target.capabilities).not.toContain('sync');
    expect(transport.supports('sync')).toBe(false);
    await expect(transport.syncPull(sync)).rejects.toMatchObject({ code: 'unsupported' });
    await expect(
      transport.syncPush(sync, bundle('t', new Date().toISOString())),
    ).rejects.toMatchObject({ code: 'unsupported' });
    await expect(
      transport.syncEnroll({
        sync,
        provider: 'claude',
        label: 'work',
        bundle: bundle('t', new Date().toISOString()),
      }),
    ).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('the fake remote serves pull, applies strictly newer pushes, and rejects unknown ids', async () => {
    const transport = createFakeRemoteTransport();
    expect(transport.supports('sync')).toBe(true);
    await expect(transport.syncPull(sync)).rejects.toMatchObject({ code: 'sync-not-enabled' });

    transport.setBundle(sync.id, bundle('t1', '2026-08-20T10:00:00.000Z'));
    expect(await transport.syncPull(sync)).toEqual(bundle('t1', '2026-08-20T10:00:00.000Z'));

    expect(await transport.syncPush(sync, bundle('t2', '2026-08-20T11:00:00.000Z'))).toEqual({
      applied: true,
    });
    expect(await transport.syncPush(sync, bundle('t0', '2026-08-20T09:00:00.000Z'))).toEqual({
      applied: false,
    });
    expect(transport.getBundle(sync.id)?.payload).toEqual(bundle('t2', '').payload);
  });

  it('the fake remote enrolls once and treats a retry as an idempotent refresh', async () => {
    const transport = createFakeRemoteTransport();
    const first = await transport.syncEnroll({
      sync,
      provider: 'claude',
      label: 'work',
      bundle: bundle('t1', '2026-08-20T10:00:00.000Z'),
    });
    const retried = await transport.syncEnroll({
      sync,
      provider: 'claude',
      label: 'renamed-at-source',
      bundle: bundle('t2', '2026-08-20T11:00:00.000Z'),
    });

    expect(retried).toEqual(first);
    expect(transport.syncEnrollments).toHaveLength(1);
    expect(transport.getBundle(sync.id)?.payload).toEqual(bundle('t2', '').payload);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for condition');
}
