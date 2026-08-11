import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Profile, ServerEvent, TargetProfileSummary } from '@apm/shared';
import { resolveConfig, type DaemonConfig } from '../config.js';
import { ApiFailure, type EventBus, type ProfileService } from '../context.js';
import { createLocalTransport } from '../targets/local.js';
import { createTargetRegistry } from '../targets/registry.js';
import { createFakeRemoteTransport } from '../targets/test-support/fake-remote.js';
import { createSessionHost, type SessionHostInternals, type SessionHostOptions } from './host.js';

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: 'profile-1',
    provider: 'claude',
    label: 'work',
    home: '/tmp/apm-test-home',
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

function fakeEvents(): { bus: EventBus; events: ServerEvent[] } {
  const events: ServerEvent[] = [];
  const bus: EventBus = {
    emit: (event) => void events.push(event),
    subscribe: () => () => undefined,
  };
  return { bus, events };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for condition');
}

describe('session host', () => {
  let dataDir: string;
  let config: DaemonConfig;
  let hosts: SessionHostInternals[];

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-host-'));
    config = resolveConfig({ dataDir });
    hosts = [];
  });

  afterEach(() => {
    for (const host of hosts) host.shutdown();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function makeHost(profiles: Profile[], options?: SessionHostOptions): SessionHostInternals {
    const { bus } = fakeEvents();
    const host = createSessionHost(config, bus, fakeProfiles(profiles), options);
    hosts.push(host);
    return host;
  }

  it('spawns a pty and records output in the scrollback', async () => {
    const host = makeHost([makeProfile()]);
    const session = await host.create({
      profileId: 'profile-1',
      app: 'sh',
      args: ['-c', 'echo hello-from-pty; sleep 5'],
      cwd: dataDir,
    });

    expect(session.status).toBe('running');
    expect(session.name).toBe('sh-work-1');
    expect(host.list()).toHaveLength(1);

    const streams = host.streams(session.id);
    expect(streams).not.toBeNull();
    await waitFor(() => (streams?.scrollback() ?? '').includes('hello-from-pty'));

    host.kill(session.id);
    await waitFor(() => host.streams(session.id)?.session().status === 'exited');
  });

  it('names sessions per app+profile with an increasing counter', async () => {
    const host = makeHost([makeProfile({ label: 'Work Account' })]);
    const first = await host.create({ profileId: 'profile-1', app: 'sh', args: ['-c', 'sleep 5'] });
    const second = await host.create({
      profileId: 'profile-1',
      app: 'sh',
      args: ['-c', 'sleep 5'],
    });
    expect(first.name).toBe('sh-work-account-1');
    expect(second.name).toBe('sh-work-account-2');
  });

  it('caps the scrollback and drops the oldest chunks', async () => {
    const host = makeHost([makeProfile()], { scrollbackBytes: 64 });
    const write = (char: string) =>
      `i=0; while [ $i -lt 200 ]; do printf ${char}; i=$((i+1)); done`;
    const session = await host.create({
      profileId: 'profile-1',
      app: 'sh',
      args: ['-c', `${write('a')}; sleep 0.2; ${write('b')}`],
      cwd: dataDir,
    });

    await waitFor(() => host.streams(session.id)?.session().status === 'exited');
    const scrollback = host.streams(session.id)?.scrollback() ?? '';
    // 400 bytes were written; the oldest chunks (all the 'a's) must be gone.
    expect(scrollback.length).toBeGreaterThan(0);
    expect(scrollback.length).toBeLessThan(400);
    expect(scrollback).toMatch(/^b+$/);
  });

  it('tracks exit code and only disposes exited sessions', async () => {
    const host = makeHost([makeProfile()]);
    const session = await host.create({
      profileId: 'profile-1',
      app: 'sh',
      args: ['-c', 'exit 3'],
      cwd: dataDir,
    });

    expect(() => host.dispose(session.id)).toThrow(ApiFailure);
    await waitFor(() => host.streams(session.id)?.session().status === 'exited');

    const exited = host.list()[0];
    expect(exited?.status).toBe('exited');
    expect(exited?.exitCode).toBe(3);
    expect(exited?.exitedAt).not.toBeNull();

    host.dispose(session.id);
    expect(host.list()).toHaveLength(0);
  });

  it('counts attached clients and fans output out to them', async () => {
    const host = makeHost([makeProfile()]);
    const session = await host.create({
      profileId: 'profile-1',
      app: 'sh',
      args: ['-c', 'echo fanout; sleep 5'],
      cwd: dataDir,
    });
    const streams = host.streams(session.id);
    if (!streams) throw new Error('no streams');

    let seen = '';
    const detach = streams.attach({
      onData: (data) => void (seen += data),
      onError: () => undefined,
      onExit: () => undefined,
    });
    expect(streams.session().attachedClients).toBe(1);
    await waitFor(() => seen.includes('fanout'));

    detach();
    expect(streams.session().attachedClients).toBe(0);
  });

  it('emits sessions-changed on create, attach and exit', async () => {
    const { bus, events } = fakeEvents();
    const host = createSessionHost(config, bus, fakeProfiles([makeProfile()]));
    hosts.push(host);

    const session = await host.create({
      profileId: 'profile-1',
      app: 'sh',
      args: ['-c', 'exit 0'],
    });
    expect(events.filter((event) => event.type === 'sessions-changed')).toHaveLength(1);

    await waitFor(() => host.streams(session.id)?.session().status === 'exited');
    expect(events.filter((event) => event.type === 'sessions-changed').length).toBeGreaterThan(1);
  });

  it('selects a remote target and preserves its profile, argv and pty events', async () => {
    const localProfiles = [makeProfile()];
    const remoteProfile: TargetProfileSummary = {
      id: 'remote-1',
      provider: 'claude',
      label: 'remote-work',
      status: 'active',
      enabled: true,
    };
    const remote = createFakeRemoteTransport({ id: 'workstation', profiles: [remoteProfile] });
    const targets = createTargetRegistry(
      createLocalTransport({ profiles: fakeProfiles(localProfiles) }),
      [remote],
    );
    const host = makeHost(localProfiles, { targets });

    await expect(
      host.create({ targetId: 'workstation', profileId: 'profile-1', app: 'claude' }),
    ).rejects.toMatchObject({ code: 'profile-not-found', statusCode: 404 });

    const session = await host.create({
      targetId: 'workstation',
      profileId: remoteProfile.id,
      app: 'claude',
      args: ['--prompt', 'spaces; $(stay-an-argument)', '--', '-x'],
      cols: 90,
      rows: 30,
    });
    expect(session).toMatchObject({ targetId: 'workstation', cwd: '~', status: 'running' });
    expect(remote.lastPty().spec).toEqual({
      argv: ['claude', '--prompt', 'spaces; $(stay-an-argument)', '--', '-x'],
      cwd: undefined,
      cols: 90,
      rows: 30,
      profileIds: [remoteProfile.id],
    });

    const streams = host.streams(session.id);
    if (!streams) throw new Error('no streams');
    let output = '';
    const errors: string[] = [];
    const exits: Array<{ exitCode: number | null; signal: string | null }> = [];
    streams.attach({
      onData: (data) => void (output += data),
      onError: (message) => void errors.push(message),
      onExit: (status) => void exits.push(status),
    });

    remote.lastPty().emit('remote output');
    streams.write('remote input');
    host.resize(session.id, 120, 40);
    host.kill(session.id);
    expect(output).toBe('remote output');
    expect(remote.lastPty().writes).toEqual(['remote input']);
    expect(remote.lastPty().resizes).toEqual([{ cols: 120, rows: 40 }]);
    expect(remote.lastPty().signals).toEqual(['SIGHUP']);

    remote.lastPty().fail('unreachable', 'remote link dropped');
    expect(errors).toEqual(['remote link dropped']);
    expect(exits).toEqual([{ exitCode: 1, signal: null }]);
    expect(streams.session().status).toBe('exited');
  });

  it('maps unknown, unapproved and unreachable target failures for session creation', async () => {
    const localProfiles = [makeProfile()];
    const remote = createFakeRemoteTransport({
      id: 'workstation',
      profiles: [
        {
          id: 'remote-1',
          provider: 'claude',
          label: 'remote',
          status: 'active',
          enabled: true,
        },
      ],
    });
    const targets = createTargetRegistry(
      createLocalTransport({ profiles: fakeProfiles(localProfiles) }),
      [remote],
    );
    const host = makeHost(localProfiles, { targets });
    const request = { targetId: 'workstation', profileId: 'remote-1', app: 'claude' };

    await expect(host.create({ ...request, targetId: 'unknown' })).rejects.toMatchObject({
      code: 'target-not-found',
      statusCode: 404,
    });
    remote.setApproved(false);
    await expect(host.create(request)).rejects.toMatchObject({
      code: 'target-not-approved',
      statusCode: 403,
    });
    remote.setApproved(true);
    remote.setOnline(false);
    await expect(host.create(request)).rejects.toMatchObject({
      code: 'target-unreachable',
      statusCode: 502,
    });
  });

  it('rejects unusable profiles, mismatched providers, bad cwd and unknown apps', async () => {
    const host = makeHost([
      makeProfile(),
      makeProfile({ id: 'disabled', label: 'off', enabled: false }),
      makeProfile({ id: 'pending', label: 'new', status: 'pending' }),
    ]);

    await expect(host.create({ profileId: 'nope', app: 'sh' })).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(host.create({ profileId: 'disabled', app: 'sh' })).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(host.create({ profileId: 'pending', app: 'sh' })).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(host.create({ profileId: 'profile-1', app: 'codex' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'provider-mismatch',
    });
    await expect(
      host.create({ profileId: 'profile-1', app: 'sh', cwd: path.join(dataDir, 'missing') }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'bad-cwd' });
    await expect(
      host.create({ profileId: 'profile-1', app: 'definitely-not-installed-xyz' }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'app-not-found' });
  });

  it('persists recent directories most-recent-first', async () => {
    const first = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-cwd-a-'));
    const second = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-cwd-b-'));
    try {
      const host = makeHost([makeProfile()]);
      expect(host.recentDirs()).toEqual([os.homedir()]);

      await host.create({ profileId: 'profile-1', app: 'sh', args: ['-c', 'exit 0'], cwd: first });
      await host.create({ profileId: 'profile-1', app: 'sh', args: ['-c', 'exit 0'], cwd: second });
      await host.create({ profileId: 'profile-1', app: 'sh', args: ['-c', 'exit 0'], cwd: first });
      expect(host.recentDirs()).toEqual([first, second]);

      // A fresh host over the same data dir reads the persisted list back.
      const reloaded = makeHost([makeProfile()]);
      expect(reloaded.recentDirs()).toEqual([first, second]);
      expect(fs.existsSync(path.join(dataDir, 'recent-dirs.json'))).toBe(true);
    } finally {
      fs.rmSync(first, { recursive: true, force: true });
      fs.rmSync(second, { recursive: true, force: true });
    }
  });
});
