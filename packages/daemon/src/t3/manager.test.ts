import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Profile, ServerEvent } from '@apm/shared';
import { resolveConfig, type DaemonConfig } from '../config.js';
import { ApiFailure, type EventBus, type ProfileService, type T3Manager } from '../context.js';
import { createT3Manager, findFreePort, type T3ManagerDeps, type T3SpawnRequest } from './manager.js';

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: 'claude-1',
    provider: 'claude',
    label: 'work',
    home: '/tmp/apm-claude-home',
    homeKind: 'external',
    identity: null,
    status: 'active',
    statusReason: null,
    enabled: true,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function fakeProfiles(profiles: Profile[]): ProfileService {
  const partial: Partial<ProfileService> = {
    list: () => profiles,
    get: (id) => profiles.find((profile) => profile.id === id) ?? null,
    envFor: (id) => {
      const profile = profiles.find((entry) => entry.id === id);
      if (!profile) return {};
      return profile.provider === 'claude'
        ? { CLAUDE_CONFIG_DIR: profile.home }
        : { CODEX_HOME: profile.home };
    },
  };
  return partial as ProfileService;
}

interface Harness {
  manager: T3Manager;
  events: ServerEvent[];
  spawns: T3SpawnRequest[];
  signals: Array<{ pid: number; signal: NodeJS.Signals }>;
}

describe('t3 manager', () => {
  let dataDir: string;
  let config: DaemonConfig;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-t3-'));
    config = resolveConfig({ dataDir });
    fs.mkdirSync(config.t3Dir, { recursive: true });
    fs.mkdirSync(config.logsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function harness(profiles: Profile[], deps: T3ManagerDeps = {}): Harness {
    const events: ServerEvent[] = [];
    const spawns: T3SpawnRequest[] = [];
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const bus: EventBus = {
      emit: (event) => void events.push(event),
      subscribe: () => () => undefined,
    };
    const manager = createT3Manager(config, bus, fakeProfiles(profiles), {
      resolveBinary: () => '/usr/bin/t3',
      spawnDetached: (req) => {
        spawns.push(req);
        return 4242;
      },
      healthCheck: async () => true,
      isAlive: () => true,
      signal: (pid, sig) => void signals.push({ pid, signal: sig }),
      findPort: async () => 4800,
      startTimeoutMs: 200,
      stopTimeoutMs: 200,
      pollIntervalMs: 5,
      ...deps,
    });
    return { manager, events, spawns, signals };
  }

  it('finds a free port and skips occupied and excluded ones', async () => {
    const base = await findFreePort(4900);
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen({ port: base, host: '127.0.0.1' }, resolve));
    try {
      expect(await findFreePort(base)).toBeGreaterThan(base);
      expect(await findFreePort(base, new Set([base, base + 1]))).toBeGreaterThan(base + 1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('round-trips instances through instances.json', async () => {
    const { manager } = harness([makeProfile()]);
    const created = await manager.create({ label: 'work t3', profiles: { claude: 'claude-1' } });

    expect(created.status).toBe('stopped');
    expect(created.baseDir).toBe(path.join(config.t3Dir, created.id));
    expect(fs.existsSync(created.baseDir)).toBe(true);

    const store = JSON.parse(fs.readFileSync(path.join(config.t3Dir, 'instances.json'), 'utf8'));
    expect(store.version).toBe(1);
    expect(store.instances).toHaveLength(1);

    const reloaded = harness([makeProfile()]).manager;
    expect(reloaded.list()).toHaveLength(1);
    expect(reloaded.list()[0]?.label).toBe('work t3');
  });

  it('rejects instances bound to unknown, mismatched or inactive profiles', async () => {
    const { manager } = harness([makeProfile({ status: 'pending', id: 'pending-1' })]);
    await expect(manager.create({ label: 'a', profiles: { claude: 'nope' } })).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(
      manager.create({ label: 'b', profiles: { codex: 'pending-1' } }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'provider-mismatch' });
    await expect(
      manager.create({ label: 'c', profiles: { claude: 'pending-1' } }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'profile-not-active' });
  });

  it('starts an instance with the profile env and marks it running when healthy', async () => {
    const { manager, spawns, events } = harness([makeProfile()]);
    const created = await manager.create({ label: 'work', profiles: { claude: 'claude-1' } });
    const started = await manager.start(created.id);

    expect(started.status).toBe('running');
    expect(started.port).toBe(4800);
    expect(started.url).toBe('http://127.0.0.1:4800');
    expect(started.pid).toBe(4242);

    const spawn = spawns[0];
    expect(spawn?.command).toBe('/usr/bin/t3');
    expect(spawn?.args).toEqual(['serve', '--port', '4800', '--base-dir', created.baseDir]);
    expect(spawn?.env.CLAUDE_CONFIG_DIR).toBe('/tmp/apm-claude-home');
    expect(spawn?.logFile).toBe(path.join(config.logsDir, `t3-${created.id}.log`));
    expect(events.filter((event) => event.type === 't3-changed').length).toBeGreaterThan(1);

    await expect(manager.start(created.id)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('fails clearly when the t3 binary is missing', async () => {
    const { manager } = harness([makeProfile()], { resolveBinary: () => null });
    const created = await manager.create({ label: 'work', profiles: { claude: 'claude-1' } });
    await expect(manager.start(created.id)).rejects.toMatchObject({
      statusCode: 400,
      code: 't3-not-found',
    });
    expect(manager.list()[0]?.status).toBe('stopped');
  });

  it('reports unhealthy on health-check timeout and exited when the process dies', async () => {
    const unhealthy = harness([makeProfile()], { healthCheck: async () => false });
    const a = await unhealthy.manager.create({ label: 'a', profiles: { claude: 'claude-1' } });
    const stalled = await unhealthy.manager.start(a.id);
    expect(stalled.status).toBe('unhealthy');
    expect(stalled.statusReason).toContain('t3-');

    const dead = harness([makeProfile()], { healthCheck: async () => false, isAlive: () => false });
    const b = await dead.manager.create({ label: 'b', profiles: { claude: 'claude-1' } });
    const gone = await dead.manager.start(b.id);
    expect(gone.status).toBe('exited');
    expect(gone.pid).toBeNull();
    expect(gone.statusReason).toContain('exited during startup');
  });

  it('stops with SIGTERM and clears runtime state', async () => {
    let alive = true;
    const sent: NodeJS.Signals[] = [];
    const { manager } = harness([makeProfile()], {
      isAlive: () => alive,
      signal: (_pid, signal) => {
        sent.push(signal);
        alive = false;
      },
    });
    const created = await manager.create({ label: 'work', profiles: { claude: 'claude-1' } });
    await manager.start(created.id);
    const stopped = await manager.stop(created.id);

    expect(sent).toEqual(['SIGTERM']);
    expect(stopped.status).toBe('stopped');
    expect(stopped.pid).toBeNull();
    expect(stopped.port).toBeNull();
    expect(stopped.url).toBeNull();
  });

  it('escalates to SIGKILL when SIGTERM is ignored', async () => {
    const { manager, signals } = harness([makeProfile()], { isAlive: () => true });
    const created = await manager.create({ label: 'work', profiles: { claude: 'claude-1' } });
    await manager.start(created.id);
    await manager.stop(created.id);
    expect(signals.map((entry) => entry.signal)).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('only removes stopped instances', async () => {
    const { manager } = harness([makeProfile()]);
    const created = await manager.create({ label: 'work', profiles: { claude: 'claude-1' } });
    await manager.start(created.id);
    await expect(manager.remove(created.id)).rejects.toMatchObject({ statusCode: 400 });

    await manager.stop(created.id);
    await manager.remove(created.id);
    expect(manager.list()).toHaveLength(0);
    expect(fs.existsSync(created.baseDir)).toBe(false);
  });

  it('re-adopts live instances and resets dead ones', async () => {
    const first = harness([makeProfile()]);
    const created = await first.manager.create({ label: 'work', profiles: { claude: 'claude-1' } });
    await first.manager.start(created.id);
    first.manager.shutdown();
    expect(first.signals).toHaveLength(0); // shutdown must never kill instances

    const adopted = harness([makeProfile()]);
    await adopted.manager.adopt();
    expect(adopted.manager.list()[0]?.status).toBe('running');
    expect(adopted.manager.list()[0]?.url).toBe('http://127.0.0.1:4800');

    const orphaned = harness([makeProfile()], { isAlive: () => false });
    await orphaned.manager.adopt();
    const instance = orphaned.manager.list()[0];
    expect(instance?.status).toBe('stopped');
    expect(instance?.pid).toBeNull();
  });

  it('surfaces ApiFailure for unknown instances', async () => {
    const { manager } = harness([makeProfile()]);
    await expect(manager.start('nope')).rejects.toBeInstanceOf(ApiFailure);
    await expect(manager.stop('nope')).rejects.toMatchObject({ statusCode: 404 });
    await expect(manager.remove('nope')).rejects.toMatchObject({ statusCode: 404 });
  });
});
