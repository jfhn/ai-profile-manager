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
import { APM_MANAGED_T3_INSTANCE_ENV } from './identity.js';
import { createT3Manager, type T3ManagerDeps, type T3SpawnRequest } from './manager.js';

const TARGET_ID = 'dev-box';
const TARGET_HOME = '/home/dev';
const TARGET_HOST = 'dev-box.tailnet.ts.net';
/** The profiles as the *target* reports them — their ids mean nothing here. */
const REMOTE_PROFILE: TargetProfileSummary = {
  id: 'claude-remote',
  provider: 'claude',
  label: 'dev box work',
  status: 'active',
  enabled: true,
};
const REMOTE_CODEX_PROFILE: TargetProfileSummary = {
  id: 'codex-remote',
  provider: 'codex',
  label: 'dev box codex',
  status: 'active',
  enabled: true,
};
const REMOTE_DISABLED_PROFILE: TargetProfileSummary = {
  id: 'codex-disabled',
  provider: 'codex',
  label: 'dev box parked',
  status: 'active',
  enabled: false,
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
      profiles: [REMOTE_PROFILE, REMOTE_CODEX_PROFILE, REMOTE_DISABLED_PROFILE],
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

  it('launches t3 detached with a profile id and a non-secret APM instance marker', async () => {
    const { manager, transport } = harness();
    const created = await create(manager);
    const started = await startHealthy(manager, transport, created.id);

    const spawn = transport.detachedSpawns[0];
    expect(spawn?.argv).toEqual(['t3', 'serve', '--port', '9100', '--base-dir', created.baseDir]);
    expect(spawn?.cwd).toBe(created.baseDir);
    expect(spawn?.instanceId).toBe(created.id);
    expect(spawn?.port).toBe(9100);
    expect(spawn?.baseDir).toBe(created.baseDir);
    // The target injects the profile's env itself; only this instance id
    // marker crosses the seam, never anything about the home or credentials.
    expect(spawn?.profileIds).toEqual([REMOTE_PROFILE.id]);
    expect(spawn?.env).toEqual({ [APM_MANAGED_T3_INSTANCE_ENV]: created.id });
    // The pid the target recorded, so the process can be found again later.
    expect(started.pid).toBe(transport.detached.get(created.id)?.state.pid);
  });

  it('binds one profile per provider and hands the target every id', async () => {
    const { manager, transport } = harness();
    const created = await manager.create({
      label: 'both',
      profiles: { claude: REMOTE_PROFILE.id, codex: REMOTE_CODEX_PROFILE.id },
      targetId: TARGET_ID,
    });
    expect(created.profiles).toEqual({
      claude: REMOTE_PROFILE.id,
      codex: REMOTE_CODEX_PROFILE.id,
    });

    const started = await startHealthy(manager, transport, created.id);
    expect(started.status).toBe('running');
    // Both opaque ids cross the seam, in provider order, and nothing else —
    // the target resolves each one to its own provider env locally.
    expect(transport.detachedSpawns[0]?.profileIds).toEqual([
      REMOTE_PROFILE.id,
      REMOTE_CODEX_PROFILE.id,
    ]);
    expect(transport.detachedSpawns[0]?.env).toEqual({
      [APM_MANAGED_T3_INSTANCE_ENV]: created.id,
    });
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

  it('validates every bound profile against the target, not just the first', async () => {
    const { manager } = harness();
    // Local ids mean nothing on the target, even next to a valid binding.
    await expect(
      manager.create({ label: 'a', profiles: { claude: 'claude-local' }, targetId: TARGET_ID }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'profile-not-found' });
    await expect(
      manager.create({
        label: 'b',
        profiles: { claude: REMOTE_PROFILE.id, codex: 'codex-nope' },
        targetId: TARGET_ID,
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'profile-not-found' });

    // A profile bound under the wrong provider key is refused per profile.
    await expect(
      manager.create({
        label: 'c',
        profiles: { claude: REMOTE_PROFILE.id, codex: REMOTE_PROFILE.id },
        targetId: TARGET_ID,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'provider-mismatch' });

    // So is one the target reports as unusable.
    await expect(
      manager.create({
        label: 'd',
        profiles: { claude: REMOTE_PROFILE.id, codex: REMOTE_DISABLED_PROFILE.id },
        targetId: TARGET_ID,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'profile-not-active' });
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
    // startable again with its process and endpoint still up on the target.
    expect((await manager.start(created.id)).status).toBe('unhealthy');
    const stale = { endpoint: transport.lastEndpoint(), pid: manager.list()[0]?.pid };

    const restarted = await startHealthy(manager, transport, created.id);
    expect(restarted.status).toBe('running');
    expect(transport.detachedSpawns).toHaveLength(2);

    // The abandoned attempt was stopped by its record rather than left
    // running over there, and its endpoint was withdrawn.
    expect(transport.detachedStops.map((stop) => stop.instanceId)).toContain(created.id);
    expect(restarted.pid).not.toBe(stale.pid);
    expect(stale.endpoint.closed).toBe(true);
    expect(stale.endpoint).not.toBe(transport.lastEndpoint());

    // Its late events belong to a runtime nobody is served by any more, so the
    // healthy instance must not notice them at all.
    stale.endpoint.drop('stale forward lost');
    const instance = manager.list()[0];
    expect(instance).toMatchObject({
      status: 'running',
      url: `http://${TARGET_HOST}:9101`,
      statusReason: null,
    });
    expect(transport.lastEndpoint().closed).toBe(false);
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

  it('stops the recorded process on the target and closes the endpoint', async () => {
    const { manager, transport } = harness();
    const created = await create(manager);
    await startHealthy(manager, transport, created.id);

    const stopped = await manager.stop(created.id);

    // The kill goes by the target's own record, not by any live handle.
    expect(transport.detachedStops).toContainEqual({
      instanceId: created.id,
      baseDir: created.baseDir,
    });
    expect(transport.detached.has(created.id)).toBe(false);
    expect(transport.lastEndpoint().closed).toBe(true);
    expect(stopped).toMatchObject({ status: 'stopped', port: null, url: null, endpoint: null });
  });

  it('fails a stop instead of pretending when the target is unreachable', async () => {
    const { manager, transport } = harness();
    const created = await create(manager);
    await startHealthy(manager, transport, created.id);

    transport.setOnline(false);
    // Claiming "stopped" would leave a server running with nobody
    // supervising it; the failure is the honest answer.
    await expect(manager.stop(created.id)).rejects.toMatchObject({
      statusCode: 502,
      code: 'target-unreachable',
    });
    expect(manager.list()[0]?.status).toBe('running');
    expect(transport.detached.get(created.id)?.alive).toBe(true);
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

  it('leaves a remote instance serving through a daemon shutdown', async () => {
    const { manager, transport } = harness();
    const created = await create(manager);
    await startHealthy(manager, transport, created.id);
    const endpoint = transport.lastEndpoint();

    await manager.shutdown();

    // Both the detached process and its published endpoint stay up on the
    // target on purpose: the instance keeps serving while apm is away, and
    // adopt() re-links it on the way back up.
    expect(transport.detached.get(created.id)?.alive).toBe(true);
    expect(endpoint.closed).toBe(false);
    // The transport's own close (daemon shutdown continues with it) leaves a
    // persistent endpoint published as well.
    await transport.close();
    expect(endpoint.closed).toBe(false);
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
    await waitFor(() => transport.detachedSpawns.length > 0);
    // What EADDRINUSE looks like from here: the process starts and dies
    // straight away instead of binding the port.
    transport.killDetached(created.id);
    const result = await starting;

    expect(result.status).toBe('exited');
    expect(result.statusReason).toContain('port 9100');
    expect(result.statusReason).toContain('still held');
    // The endpoint does not stay published behind a process that is gone.
    expect(transport.lastEndpoint().closed).toBe(true);
  });

  /** Restart the daemon: a fresh harness against the same target-side state. */
  async function restartAndAdopt(first: Harness): Promise<Harness> {
    const survivor = [...first.transport.detached.values()].some((record) => record.alive);
    await first.manager.shutdown();
    const next = harness({ detachedStore: first.transport.detached });
    const adopting = next.manager.adopt();
    if (survivor) {
      // The target answers on its re-published endpoint as soon as it exists.
      await waitFor(() => next.transport.endpoints.length > 0);
      next.transport.lastEndpoint().setHealthy(true);
    }
    await adopting;
    return next;
  }

  it('re-adopts a remote instance that kept serving across a restart', async () => {
    const first = harness();
    const created = await create(first.manager);
    const started = await startHealthy(first.manager, first.transport, created.id);

    const adopted = await restartAndAdopt(first);
    const instance = adopted.manager.list()[0];
    expect(instance).toMatchObject({
      id: created.id,
      status: 'running',
      pid: started.pid,
      port: started.port,
      url: `http://${TARGET_HOST}:${started.port}`,
      statusReason: null,
    });
    // Re-adopted, not relaunched: the process over there was never touched.
    expect(adopted.transport.detachedSpawns).toHaveLength(0);
    expect(adopted.transport.detachedStops).toHaveLength(0);
    // The re-published endpoint asked for the recorded port, not a new one.
    expect(adopted.transport.lastEndpoint().request.port).toBe(started.port);
  });

  it('reports an instance that died while apm was away as stopped, never relaunches it', async () => {
    const first = harness();
    const created = await create(first.manager);
    await startHealthy(first.manager, first.transport, created.id);
    first.transport.killDetached(created.id);

    const adopted = await restartAndAdopt(first);
    const instance = adopted.manager.list()[0];
    expect(instance).toMatchObject({
      id: created.id,
      status: 'stopped',
      pid: null,
      port: null,
      url: null,
      endpoint: null,
    });
    expect(instance?.statusReason).toContain('while apm was down');
    expect(adopted.transport.detachedSpawns).toHaveLength(0);
    expect(adopted.transport.endpoints).toHaveLength(0);
  });

  it('stops a process recorded by a previous daemon', async () => {
    const first = harness();
    const created = await create(first.manager);
    await startHealthy(first.manager, first.transport, created.id);

    // The daemon that spawned the process is gone; the record is not.
    const adopted = await restartAndAdopt(first);
    const stopped = await adopted.manager.stop(created.id);

    expect(stopped.status).toBe('stopped');
    expect(adopted.transport.detachedStops).toContainEqual({
      instanceId: created.id,
      baseDir: created.baseDir,
    });
    expect(adopted.transport.detached.has(created.id)).toBe(false);
    expect(adopted.transport.lastEndpoint().closed).toBe(true);
  });

  it('degrades to a clear error when the target agent is too old', async () => {
    // Start: refused with the transport's own words, instance left stopped.
    const outdated = harness({ detachedUnsupported: true });
    const created = await create(outdated.manager);
    await expect(outdated.manager.start(created.id)).rejects.toMatchObject({
      statusCode: 400,
      code: 'target-unsupported',
    });
    expect(outdated.manager.list()[0]?.status).toBe('stopped');

    // Adoption: the same degradation, as a reported reason, never a crash.
    const first = harness();
    const started = await create(first.manager);
    await startHealthy(first.manager, first.transport, started.id);
    await first.manager.shutdown();
    const adopted = harness({
      detachedStore: first.transport.detached,
      detachedUnsupported: true,
    });
    await adopted.manager.adopt();
    // Both harnesses share the store file, so select the started instance.
    const instance = adopted.manager.list().find((entry) => entry.id === started.id);
    expect(instance?.status).toBe('stopped');
    expect(instance?.statusReason).toContain('too old');
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
