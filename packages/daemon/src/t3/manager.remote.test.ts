/**
 * Managed T3 instances on a remote target, driven entirely through the
 * deterministic fake transport: no sockets, no processes, and no second
 * execution path — everything the manager does over there is a transport call
 * this suite can read back.
 *
 * The local-target behaviour it must not disturb is covered by manager.test.ts.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Profile, ServerEvent, T3Instance, TargetProfileSummary } from '@apm/shared';
import { resolveConfig, type DaemonConfig } from '../config.js';
import type { EventBus, ProfileService, T3Manager } from '../context.js';
import { createLocalTransport } from '../targets/local.js';
import { createTargetRegistry } from '../targets/registry.js';
import {
  createFakeRemoteTransport,
  type FakeRemoteOptions,
  type FakeRemoteTransport,
} from '../targets/test-support/fake-remote.js';
import { createT3Manager, type T3ManagerDeps, type T3SpawnRequest } from './manager.js';

const TARGET_ID = 'dev-box';
const TARGET_HOME = '/home/dev';
const TARGET_HOST = 'dev-box.tailnet.ts.net';
/** The profile as the *target* reports it — its ids mean nothing here. */
const REMOTE_PROFILE: TargetProfileSummary = {
  id: 'claude-remote',
  provider: 'claude',
  label: 'dev box work',
  status: 'active',
  enabled: true,
};

/** A local profile, for the tests that put both targets side by side. */
function localProfile(): Profile {
  return {
    id: 'claude-local',
    provider: 'claude',
    label: 'work',
    home: '/tmp/apm-claude-home',
    homeKind: 'external',
    identity: null,
    status: 'active',
    statusReason: null,
    enabled: true,
    createdAt: new Date().toISOString(),
  };
}

function fakeProfiles(profiles: Profile[]): ProfileService {
  const partial: Partial<ProfileService> = {
    list: () => profiles,
    get: (id) => profiles.find((profile) => profile.id === id) ?? null,
    envFor: (id) => {
      const profile = profiles.find((entry) => entry.id === id);
      return profile ? { CLAUDE_CONFIG_DIR: profile.home } : {};
    },
  };
  return partial as ProfileService;
}

interface Harness {
  manager: T3Manager;
  transport: FakeRemoteTransport;
  events: ServerEvent[];
  spawns: T3SpawnRequest[];
  /** Exclusion sets the local port scan was asked about, in order. */
  localPortScans: number[][];
}

describe('t3 manager on a remote target', () => {
  let dataDir: string;
  let config: DaemonConfig;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-t3-remote-'));
    config = resolveConfig({ dataDir });
    fs.mkdirSync(config.t3Dir, { recursive: true });
    fs.mkdirSync(config.logsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function harness(remote: FakeRemoteOptions = {}, deps: T3ManagerDeps = {}): Harness {
    const events: ServerEvent[] = [];
    const spawns: T3SpawnRequest[] = [];
    const localPortScans: number[][] = [];
    const bus: EventBus = {
      emit: (event) => void events.push(event),
      subscribe: () => () => undefined,
    };
    const profiles = fakeProfiles([localProfile()]);
    const transport = createFakeRemoteTransport({
      id: TARGET_ID,
      label: 'dev box',
      profiles: [REMOTE_PROFILE],
      // What a tailnet transport does: the instance answers on the target's
      // own address, not on anything this machine forwards.
      endpointScope: 'published',
      endpointHost: TARGET_HOST,
      ...remote,
    });
    transport.scriptExec(['printenv', 'HOME'], { stdout: `${TARGET_HOME}\n` });
    const targets = createTargetRegistry(createLocalTransport({ profiles }), [transport]);
    const manager = createT3Manager(config, bus, profiles, {
      targets,
      resolveBinary: () => '/usr/bin/t3',
      spawnDetached: (req) => {
        spawns.push(req);
        return 4242;
      },
      healthCheck: async () => true,
      isAlive: () => true,
      findPort: async (exclude) => {
        localPortScans.push([...exclude]);
        return 4800;
      },
      startTimeoutMs: 200,
      stopTimeoutMs: 50,
      pollIntervalMs: 5,
      ...deps,
    });
    return { manager, transport, events, spawns, localPortScans };
  }

  function create(manager: T3Manager, label = 'dev'): Promise<T3Instance> {
    return manager.create({
      label,
      profiles: { claude: REMOTE_PROFILE.id },
      targetId: TARGET_ID,
    });
  }

  /** Start, letting the target's endpoint answer once the manager opened it. */
  async function startHealthy(
    manager: T3Manager,
    transport: FakeRemoteTransport,
    id: string,
  ): Promise<T3Instance> {
    const opened = transport.endpoints.length;
    const starting = manager.start(id);
    await waitFor(() => transport.endpoints.length > opened);
    transport.lastEndpoint().setHealthy(true);
    return starting;
  }

  it('resolves the base dir on the target and leaves nothing on this machine', async () => {
    const { manager, transport } = harness();
    const created = await create(manager);

    expect(created.targetId).toBe(TARGET_ID);
    expect(created.baseDir).toBe(`${TARGET_HOME}/.local/share/apm/t3/${created.id}`);
    expect(transport.execs.map((call) => call.spec.argv)).toEqual([
      ['printenv', 'HOME'],
      ['mkdir', '-m', '700', '-p', created.baseDir],
    ]);
    expect(fs.existsSync(path.join(config.t3Dir, created.id))).toBe(false);
  });

  it('launches t3 as argv with a profile id and no provider environment', async () => {
    const { manager, transport } = harness();
    const created = await create(manager);
    const started = await startHealthy(manager, transport, created.id);

    const pty = transport.lastPty();
    expect(pty.spec.argv).toEqual(['t3', 'serve', '--port', '9100', '--base-dir', created.baseDir]);
    expect(pty.spec.cwd).toBe(created.baseDir);
    // The target injects the profile's env itself; nothing about the home or
    // its credentials crosses the seam.
    expect(pty.spec.profileId).toBe(REMOTE_PROFILE.id);
    expect(pty.spec.env).toBeUndefined();
    expect(started.pid).toBeNull();
  });

  it('opens the instance on the target address the transport published', async () => {
    const { manager, transport } = harness();
    const created = await create(manager);
    const started = await startHealthy(manager, transport, created.id);

    expect(started.status).toBe('running');
    expect(started.port).toBe(9100);
    expect(started.url).toBe(`http://${TARGET_HOST}:9100`);
    expect(started.endpoint).toEqual({
      scope: 'published',
      protocol: 'http',
      port: 9100,
      url: `http://${TARGET_HOST}:9100`,
    });
    expect(transport.lastEndpoint().request.port).toBeNull(); // the target allocates
  });

  it('persists the target and endpoint across a manager reload', async () => {
    const first = harness();
    const created = await create(first.manager);
    await startHealthy(first.manager, first.transport, created.id);

    const store = JSON.parse(fs.readFileSync(path.join(config.t3Dir, 'instances.json'), 'utf8'));
    expect(store.instances[0].targetId).toBe(TARGET_ID);

    const reloaded = harness().manager.list()[0];
    expect(reloaded?.targetId).toBe(TARGET_ID);
    expect(reloaded?.endpoint).toEqual({
      scope: 'published',
      protocol: 'http',
      port: 9100,
      url: `http://${TARGET_HOST}:9100`,
    });
  });

  it('reads an instance written before targets existed as a local one', () => {
    fs.writeFileSync(
      path.join(config.t3Dir, 'instances.json'),
      JSON.stringify({
        version: 1,
        instances: [
          {
            id: 'legacy',
            label: 'old',
            port: null,
            baseDir: '/tmp/legacy',
            profiles: { claude: 'claude-local' },
            status: 'stopped',
            pid: null,
            url: null,
            statusReason: null,
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    );
    const instance = harness().manager.list()[0];
    expect(instance?.targetId).toBe('local');
    expect(instance?.endpoint).toBeNull();
  });

  it('refuses to link a remote instance to a loopback endpoint', async () => {
    const { manager, transport } = harness({
      endpointScope: 'loopback',
      endpointHost: '127.0.0.1',
    });
    const created = await create(manager);

    await expect(manager.start(created.id)).rejects.toMatchObject({
      statusCode: 502,
      code: 'endpoint-failed',
    });
    expect(transport.ptys).toHaveLength(0);
    expect(transport.lastEndpoint().closed).toBe(true);
    expect(manager.list()[0]?.status).toBe('stopped');
  });

  it('reports an unreachable, unapproved or incapable target', async () => {
    const offline = harness();
    const a = await create(offline.manager);
    offline.transport.setOnline(false);
    await expect(offline.manager.start(a.id)).rejects.toMatchObject({
      statusCode: 502,
      code: 'target-unreachable',
    });

    const unapproved = harness();
    const b = await create(unapproved.manager);
    unapproved.transport.setApproved(false);
    await expect(unapproved.manager.start(b.id)).rejects.toMatchObject({
      statusCode: 403,
      code: 'target-not-approved',
    });

    const noEndpoint = harness({ capabilities: ['exec', 'pty', 'signal', 'profiles'] });
    await expect(create(noEndpoint.manager)).rejects.toMatchObject({
      statusCode: 400,
      code: 'target-unsupported',
    });
  });

  it('reports a missing t3 on the target and releases the endpoint', async () => {
    const { manager, transport } = harness();
    const created = await create(manager);
    transport.scriptFailure(
      ['t3', 'serve', '--port', '9100', '--base-dir', created.baseDir],
      'command-not-found',
      'Command not found: t3',
    );

    await expect(manager.start(created.id)).rejects.toMatchObject({
      statusCode: 400,
      code: 'app-not-found',
    });
    expect(transport.lastEndpoint().closed).toBe(true);
    expect(manager.list()[0]?.status).toBe('stopped');
  });

  it('rejects a profile the target does not have, and more than one profile', async () => {
    const { manager } = harness();
    await expect(
      manager.create({ label: 'a', profiles: { claude: 'claude-local' }, targetId: TARGET_ID }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'profile-not-found' });

    await expect(
      manager.create({
        label: 'b',
        profiles: { claude: REMOTE_PROFILE.id, codex: 'codex-remote' },
        targetId: TARGET_ID,
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'multi-profile-unsupported' });
  });

  it('reports an endpoint that never answers as unhealthy', async () => {
    const { manager } = harness({}, { startTimeoutMs: 30 });
    const created = await create(manager);
    const started = await manager.start(created.id);

    expect(started.status).toBe('unhealthy');
    expect(started.statusReason).toBeTruthy();
    expect(started.url).toBeNull();
  });

  it('retires the first attempt when an unhealthy instance is started again', async () => {
    const { manager, transport } = harness({}, { startTimeoutMs: 30 });
    const created = await create(manager);

    // First attempt: the endpoint never answers, which leaves the instance
    // startable again with its pty and endpoint still open on the target.
    expect((await manager.start(created.id)).status).toBe('unhealthy');
    const stale = { pty: transport.lastPty(), endpoint: transport.lastEndpoint() };

    const restarted = await startHealthy(manager, transport, created.id);
    expect(restarted.status).toBe('running');
    expect(transport.ptys).toHaveLength(2);

    // The abandoned attempt was torn down rather than left running over there.
    expect(stale.pty.exited).toBe(true);
    expect(stale.endpoint.closed).toBe(true);
    expect(stale.pty).not.toBe(transport.lastPty());

    // Its late events belong to a runtime nobody is served by any more, so the
    // healthy instance must not notice them at all.
    stale.pty.exit({ exitCode: 1 });
    stale.endpoint.drop('stale forward lost');
    const instance = manager.list()[0];
    expect(instance).toMatchObject({
      status: 'running',
      url: `http://${TARGET_HOST}:9101`,
      statusReason: null,
    });
    expect(transport.lastEndpoint().closed).toBe(false);
  });

  it('reports an exit by status only, never by output', async () => {
    const { manager, transport } = harness();
    const created = await create(manager);
    await startHealthy(manager, transport, created.id);

    transport.lastPty().exit({ exitCode: 1 });
    const instance = manager.list()[0];
    expect(instance?.status).toBe('exited');
    expect(instance?.statusReason).toBe(`t3 exited with code 1 on target "${TARGET_ID}"`);
    expect(instance?.url).toBeNull();
    expect(instance?.endpoint).toBeNull();
  });

  it('blames a live transport failure rather than the exit it causes', async () => {
    const { manager, transport } = harness();
    const created = await create(manager);
    await startHealthy(manager, transport, created.id);

    // onError first, then the exit the dead connection synthesizes.
    transport.lastPty().fail('unreachable', 'connection reset');
    const instance = manager.list()[0];
    expect(instance?.status).toBe('exited');
    expect(instance?.statusReason).toBe(
      `The connection to target "${TARGET_ID}" failed: connection reset`,
    );
  });

  it('marks the instance unhealthy when the endpoint drops on its own', async () => {
    const { manager, transport } = harness();
    const created = await create(manager);
    await startHealthy(manager, transport, created.id);

    transport.lastEndpoint().drop('forward lost');
    const instance = manager.list()[0];
    expect(instance?.status).toBe('unhealthy');
    expect(instance?.statusReason).toContain('forward lost');
    expect(instance?.url).toBeNull();
  });

  it('stops with SIGTERM and closes the endpoint', async () => {
    const { manager, transport } = harness();
    const created = await create(manager);
    await startHealthy(manager, transport, created.id);

    const stopping = manager.stop(created.id);
    transport.lastPty().exit({ signal: 'SIGTERM' });
    const stopped = await stopping;

    expect(transport.lastPty().signals).toEqual(['SIGTERM']);
    expect(transport.lastEndpoint().closed).toBe(true);
    expect(stopped).toMatchObject({ status: 'stopped', port: null, url: null, endpoint: null });
  });

  it('escalates to SIGKILL when the remote process ignores SIGTERM', async () => {
    const { manager, transport } = harness();
    const created = await create(manager);
    await startHealthy(manager, transport, created.id);

    await manager.stop(created.id);
    expect(transport.lastPty().signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('allocates ports per target', async () => {
    const { manager, transport, localPortScans } = harness();
    const first = await create(manager, 'first');
    const second = await create(manager, 'second');
    expect((await startHealthy(manager, transport, first.id)).port).toBe(9100);
    expect((await startHealthy(manager, transport, second.id)).port).toBe(9101);

    const local = await manager.create({ label: 'local', profiles: { claude: 'claude-local' } });
    expect((await manager.start(local.id)).port).toBe(4800);
    // Ports are a per-target namespace: the target's 9100/9101 are none of the
    // local scan's business, and 4800 stays free over there.
    expect(localPortScans.at(-1)).toEqual([]);
  });

  it('terminates remote instances and revokes their endpoints on shutdown', async () => {
    const { manager, transport } = harness();
    const created = await create(manager);
    await startHealthy(manager, transport, created.id);
    const pty = transport.lastPty();
    const endpoint = transport.lastEndpoint();

    await manager.shutdown();

    // Nothing on the target may outlive the daemon that was supervising it:
    // leaving either behind is how a restart met an occupied port and a
    // published URL nobody was watching.
    expect(pty.exited).toBe(true);
    expect(endpoint.closed).toBe(true);
  });

  it('leaves a local instance running when the daemon shuts down', async () => {
    const { manager, spawns } = harness();
    const local = await manager.create({ label: 'local', profiles: { claude: 'claude-local' } });
    await manager.start(local.id);

    await manager.shutdown();
    // Local instances are detached on purpose and are re-adopted on the way up.
    expect(spawns).toHaveLength(1);
    expect(manager.list()[0]?.status).toBe('running');
  });

  it('names the port when t3 dies before it ever answers', async () => {
    const { manager, transport } = harness({}, { startTimeoutMs: 40 });
    const created = await create(manager);

    const starting = manager.start(created.id);
    await waitFor(() => transport.ptys.length > 0);
    // What EADDRINUSE looks like from here: the process starts and exits
    // straight away instead of binding the port.
    transport.lastPty().exit({ exitCode: 1 });
    const result = await starting;

    expect(result.status).toBe('exited');
    expect(result.statusReason).toContain('port 9100');
    expect(result.statusReason).toContain('still held');
    // The endpoint does not stay published behind a process that is gone.
    expect(transport.lastEndpoint().closed).toBe(true);
  });

  it('reports remote instances as stopped after a daemon restart', async () => {
    const first = harness();
    const created = await create(first.manager);
    await startHealthy(first.manager, first.transport, created.id);
    await first.manager.shutdown();

    const adopted = harness();
    await adopted.manager.adopt();
    const instance = adopted.manager.list()[0];
    expect(instance).toMatchObject({
      id: created.id,
      status: 'stopped',
      port: null,
      url: null,
      endpoint: null,
    });
  });

  it('removes a stopped remote instance without touching the target', async () => {
    const { manager, transport } = harness();
    const created = await create(manager);
    const execs = transport.execs.length;

    await manager.remove(created.id);
    expect(manager.list()).toHaveLength(0);
    // Nothing runs on the target: deleting a path we cannot see is not worth it.
    expect(transport.execs).toHaveLength(execs);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for condition');
}
