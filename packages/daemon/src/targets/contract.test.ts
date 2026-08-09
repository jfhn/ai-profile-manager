/**
 * The transport contract, run against every implementation we have: the real
 * local transport and the deterministic fake remote one. Anything asserted
 * here is what #18 (CLI) and #19 (T3) may rely on for *any* target.
 */
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isTransportError,
  type CommandSpec,
  type EndpointHandle,
  type EndpointRequest,
  type Profile,
  type PtyHandle,
  type PtySpec,
  type TargetTransport,
} from '@apm/shared';
import type { ProfileService } from '../context.js';
import { createLocalTransport } from './local.js';
import { allocatePort } from './net.js';
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
  /** A request for an endpoint whose service is not answering yet. */
  endpointRequest(): Promise<EndpointRequest>;
  /** Make the endpoint's service answer. */
  serve(handle: EndpointHandle): Promise<void>;
  cleanup(): Promise<void>;
}

function fakeProfiles(): Pick<ProfileService, 'list' | 'envFor'> {
  return {
    list: () => [PROFILE],
    envFor: (id) => (id === PROFILE.id ? { CLAUDE_CONFIG_DIR: PROFILE.home } : {}),
  };
}

async function localFixture(): Promise<Fixture> {
  const transport = createLocalTransport({ profiles: fakeProfiles(), pollIntervalMs: 20 });
  const servers: http.Server[] = [];
  return {
    transport,
    echo: (text) => ({ argv: ['printf', '%s', text] }),
    exitWith: (code) => ({ argv: ['sh', '-c', `exit ${code}`] }),
    missingCommand: () => ({ argv: ['definitely-not-installed-xyz'] }),
    badCwd: () => ({ argv: ['pwd'], cwd: '/definitely/not/a/directory' }),
    interactive: () => ({ argv: ['cat'], cols: 80, rows: 24 }),
    produce: (handle, text) => handle.write(text),
    endpointRequest: async () => ({ port: await allocatePort() }),
    serve: (handle) =>
      new Promise<void>((resolve) => {
        const server = http.createServer((_req, res) => res.end('ok'));
        servers.push(server);
        server.listen({ port: handle.endpoint.port, host: '127.0.0.1' }, () => resolve());
      }),
    cleanup: async () => {
      for (const server of servers) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
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
    endpointRequest: async () => ({ port: null }),
    serve: async () => transport.lastEndpoint().setHealthy(true),
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

  it('publishes an endpoint that becomes healthy and then closed', async () => {
    const { transport, endpointRequest, serve } = await setup();
    const handle = await transport.openEndpoint(await endpointRequest());
    expect(handle.endpoint.targetId).toBe(transport.target.id);
    expect(handle.endpoint.port).toBeGreaterThan(0);

    const before = await handle.health();
    expect(before.state).toBe('unhealthy');
    expect(before.reason).not.toBeNull();
    expect(handle.endpoint.url).toBeNull();

    await serve(handle);
    const healthy = await handle.waitUntilHealthy(5_000);
    expect(healthy.state).toBe('healthy');
    expect(handle.endpoint.url).toMatch(/^http:\/\//);

    const closes: Array<string | null> = [];
    handle.onClose((reason) => void closes.push(reason));
    await handle.close();
    expect(closes).toEqual([null]);
    expect(handle.endpoint.url).toBeNull();
    expect((await handle.health()).state).toBe('closed');
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

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for condition');
}
