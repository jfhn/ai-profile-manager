import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CredentialBundle, UsageSnapshot } from '@apm/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureDirs, resolveConfig } from '../config.js';
import { ApiFailure, type UsageService } from '../context.js';
import { createEventBus } from '../core/events.js';
import { createProfileService } from '../core/profiles.js';
import { createLocalTransport } from './local.js';
import { createTargetRegistry } from './registry.js';
import { createFakeRemoteTransport } from './test-support/fake-remote.js';
import { adoptProfile, createSyncService } from './sync.js';

const SYNC_ID = '11111111-2222-4333-8444-555555555555';
const T0 = Date.parse('2026-08-20T09:00:00.000Z');
const T1 = Date.parse('2026-08-20T10:00:00.000Z');
const T2 = Date.parse('2026-08-20T11:00:00.000Z');
const T3 = Date.parse('2026-08-20T12:00:00.000Z');

const temporaryDirectories: string[] = [];
const stops: Array<() => void> = [];

afterEach(() => {
  stops.splice(0).forEach((stop) => stop());
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function tempConfig() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-sync-test-'));
  temporaryDirectories.push(directory);
  const config = resolveConfig({ dataDir: directory });
  ensureDirs(config);
  return config;
}

function writeClaudeHome(parent: string, name: string, token: string, mtimeMs: number): string {
  const home = path.join(parent, name);
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, '.credentials.json');
  fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: token } }));
  fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return home;
}

function claudeBundle(token: string, rotatedAtMs: number): CredentialBundle {
  return {
    provider: 'claude',
    rotatedAt: new Date(rotatedAtMs).toISOString(),
    payload: { claudeAiOauth: { accessToken: token } },
  };
}

function fakeUsage(): UsageService & { refreshes: Array<{ id?: string; force?: boolean }> } {
  const refreshes: Array<{ id?: string; force?: boolean }> = [];
  return {
    refreshes,
    latest: () => ({}),
    async refresh(id, options) {
      refreshes.push({ id, force: options?.force });
    },
    start() {},
    stop() {},
  };
}

function authFailureSnapshot(profileId: string): UsageSnapshot {
  return {
    profileId,
    windows: [],
    fetchedAt: new Date().toISOString(),
    source: 'test',
    cacheStatus: 'error',
    dataUpdatedAt: null,
    stale: true,
    staleReason: 'rejected credentials',
    failureKind: 'auth',
    error: 'rejected credentials',
    planType: null,
    retryAfterSeconds: null,
  };
}

describe('credential sync service', () => {
  it('pushes an owner rotation to approved peers once per mtime change', async () => {
    const config = tempConfig();
    const events = createEventBus();
    const profiles = createProfileService(config, events);
    const home = writeClaudeHome(config.dataDir, 'owner-home', 'sync-t1', T1);
    const created = await profiles.create({ provider: 'claude', label: 'work', home });
    profiles.enableSync(created.id);

    const remote = createFakeRemoteTransport();
    const targets = createTargetRegistry(
      createLocalTransport({ profiles, shimsDir: config.shimsDir }),
      [remote],
    );
    const usage = fakeUsage();
    const service = createSyncService(profiles, targets, usage, events);

    await service.tick();
    expect(remote.syncPushes).toHaveLength(1);
    expect(remote.syncPushes[0]?.bundle).toEqual(claudeBundle('sync-t1', T1));
    expect(remote.syncPushes[0]?.sync.role).toBe('owner');

    // No change, no push.
    await service.tick();
    expect(remote.syncPushes).toHaveLength(1);

    // A rotation (newer mtime) is pushed again.
    const file = path.join(home, '.credentials.json');
    fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: 'sync-t2' } }));
    fs.utimesSync(file, T2 / 1000, T2 / 1000);
    await service.tick();
    expect(remote.syncPushes).toHaveLength(2);
    expect(remote.syncPushes[1]?.bundle).toEqual(claudeBundle('sync-t2', T2));
  });

  it('never pushes to an unapproved peer', async () => {
    const config = tempConfig();
    const events = createEventBus();
    const profiles = createProfileService(config, events);
    const home = writeClaudeHome(config.dataDir, 'owner-home', 'sync-t1', T1);
    const created = await profiles.create({ provider: 'claude', label: 'work', home });
    profiles.enableSync(created.id);

    const remote = createFakeRemoteTransport({ approved: false });
    const targets = createTargetRegistry(
      createLocalTransport({ profiles, shimsDir: config.shimsDir }),
      [remote],
    );
    const service = createSyncService(profiles, targets, fakeUsage(), events);
    await service.tick();
    expect(remote.syncPushes).toHaveLength(0);
  });

  it('pulls on a replica auth failure, applies the peer bundle, and forces a refresh', async () => {
    const config = tempConfig();
    const events = createEventBus();
    const profiles = createProfileService(config, events);
    const home = writeClaudeHome(config.homesDir, 'replica-home', 'dead-token', T2);
    const replica = await profiles.createReplica({
      provider: 'claude',
      label: 'work',
      home,
      sync: { id: SYNC_ID, role: 'replica' },
    });

    const remote = createFakeRemoteTransport();
    remote.setBundle(SYNC_ID, claudeBundle('fresh-token', T3));
    const targets = createTargetRegistry(
      createLocalTransport({ profiles, shimsDir: config.shimsDir }),
      [remote],
    );
    const usage = fakeUsage();
    const service = createSyncService(profiles, targets, usage, events);
    service.start();
    stops.push(() => service.stop());

    events.emit({
      type: 'usage-updated',
      profileId: replica.id,
      snapshot: authFailureSnapshot(replica.id),
    });

    const file = path.join(home, '.credentials.json');
    await vi.waitFor(() => {
      const record = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        claudeAiOauth: { accessToken: string };
      };
      expect(record.claudeAiOauth.accessToken).toBe('fresh-token');
    });
    expect(Math.trunc(fs.statSync(file).mtimeMs)).toBe(T3);
    await vi.waitFor(() => {
      expect(usage.refreshes).toContainEqual({ id: replica.id, force: true });
    });

    // The same failure again inside the cooldown pulls nothing new.
    events.emit({
      type: 'usage-updated',
      profileId: replica.id,
      snapshot: authFailureSnapshot(replica.id),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(usage.refreshes).toHaveLength(1);
  });

  it('advances to the next untried candidate per round and forgets them on success', async () => {
    const config = tempConfig();
    const events = createEventBus();
    const profiles = createProfileService(config, events);
    // The local dead token predates both peer bundles, so the startup push
    // sweep cannot replace either peer's offer.
    const home = writeClaudeHome(config.homesDir, 'replica-home', 'dead-token', T0);
    const replica = await profiles.createReplica({
      provider: 'claude',
      label: 'work',
      home,
      sync: { id: SYNC_ID, role: 'replica' },
    });
    const file = path.join(home, '.credentials.json');

    // Peer A offers the newest (future-dated, still bad) bundle, peer B an
    // older valid one. Tried-payload memory must reach B on the second round.
    const peerA = createFakeRemoteTransport({ id: 'peer-a' });
    peerA.setBundle(SYNC_ID, claudeBundle('bad-newest', T3));
    const peerB = createFakeRemoteTransport({ id: 'peer-b' });
    peerB.setBundle(SYNC_ID, claudeBundle('good-older', T1));
    const targets = createTargetRegistry(
      createLocalTransport({ profiles, shimsDir: config.shimsDir }),
      [peerA, peerB],
    );
    const usage = fakeUsage();
    const service = createSyncService(profiles, targets, usage, events, undefined, {
      pullCooldownMs: 0,
    });
    service.start();
    stops.push(() => service.stop());

    const token = () =>
      (JSON.parse(fs.readFileSync(file, 'utf8')) as { claudeAiOauth: { accessToken: string } })
        .claudeAiOauth.accessToken;
    const fail = () =>
      events.emit({
        type: 'usage-updated',
        profileId: replica.id,
        snapshot: authFailureSnapshot(replica.id),
      });

    fail();
    await vi.waitFor(() => expect(token()).toBe('bad-newest'));
    await vi.waitFor(() => expect(usage.refreshes).toHaveLength(1));

    fail();
    await vi.waitFor(() => expect(token()).toBe('good-older'));
    await vi.waitFor(() => expect(usage.refreshes).toHaveLength(2));

    // A successful collection clears the tried set: the previously tried
    // newest candidate becomes eligible again on the next failure.
    events.emit({
      type: 'usage-updated',
      profileId: replica.id,
      snapshot: { ...authFailureSnapshot(replica.id), failureKind: null, error: null },
    });
    fail();
    await vi.waitFor(() => expect(token()).toBe('bad-newest'));
    await vi.waitFor(() => expect(usage.refreshes).toHaveLength(3));
  });

  it('aborts the pull when local credentials change while peers are queried', async () => {
    const config = tempConfig();
    const events = createEventBus();
    const profiles = createProfileService(config, events);
    const home = writeClaudeHome(config.homesDir, 'replica-home', 'dead-token', T1);
    const replica = await profiles.createReplica({
      provider: 'claude',
      label: 'work',
      home,
      sync: { id: SYNC_ID, role: 'replica' },
    });
    const file = path.join(home, '.credentials.json');

    const remote = createFakeRemoteTransport();
    remote.setBundle(SYNC_ID, claudeBundle('peer-token', T3));
    // A provider CLI rotates the local credentials in the middle of the pull.
    const originalPull = remote.syncPull.bind(remote);
    remote.syncPull = async (sync) => {
      fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: 'cli-rotated' } }));
      fs.utimesSync(file, T2 / 1000, T2 / 1000);
      return originalPull(sync);
    };
    const targets = createTargetRegistry(
      createLocalTransport({ profiles, shimsDir: config.shimsDir }),
      [remote],
    );
    const usage = fakeUsage();
    const service = createSyncService(profiles, targets, usage, events, undefined, {
      pullCooldownMs: 0,
    });
    service.start();
    stops.push(() => service.stop());

    const token = () =>
      (JSON.parse(fs.readFileSync(file, 'utf8')) as { claudeAiOauth: { accessToken: string } })
        .claudeAiOauth.accessToken;
    events.emit({
      type: 'usage-updated',
      profileId: replica.id,
      snapshot: authFailureSnapshot(replica.id),
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(token()).toBe('cli-rotated');
    expect(usage.refreshes).toHaveLength(0);

    // The aborted round consumed nothing: when the rotated credential fails
    // too, the same peer candidate is still eligible and now applies.
    events.emit({
      type: 'usage-updated',
      profileId: replica.id,
      snapshot: authFailureSnapshot(replica.id),
    });
    await vi.waitFor(() => expect(token()).toBe('peer-token'));
    await vi.waitFor(() => expect(usage.refreshes).toHaveLength(1));
  });

  it('repeats only transport codes, never remote message text, in its logs', async () => {
    const config = tempConfig();
    const events = createEventBus();
    const profiles = createProfileService(config, events);
    const home = writeClaudeHome(config.dataDir, 'owner-home', 'sync-t1', T1);
    const created = await profiles.create({ provider: 'claude', label: 'work', home });
    profiles.enableSync(created.id);
    const replicaHome = writeClaudeHome(config.homesDir, 'replica-home', 'dead-token', T2);
    const replica = await profiles.createReplica({
      provider: 'claude',
      label: 'replica',
      home: replicaHome,
      sync: { id: SYNC_ID, role: 'replica' },
    });

    const remote = createFakeRemoteTransport();
    remote.scriptSyncFailure('unreachable', 'Authorization: Bearer sk-SECRET-material');
    const targets = createTargetRegistry(
      createLocalTransport({ profiles, shimsDir: config.shimsDir }),
      [remote],
    );
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
    stops.push(() => spy.mockRestore());

    const service = createSyncService(profiles, targets, fakeUsage(), events, undefined, {
      pullCooldownMs: 0,
    });
    service.start();
    stops.push(() => service.stop());
    await service.tick();
    events.emit({
      type: 'usage-updated',
      profileId: replica.id,
      snapshot: authFailureSnapshot(replica.id),
    });
    await vi.waitFor(() => {
      expect(logged.some((line) => line.includes('skipped'))).toBe(true);
    });
    expect(logged.some((line) => line.includes('dropped'))).toBe(true);
    expect(logged.join('\n')).not.toContain('sk-SECRET');
    expect(logged.join('\n')).toContain('unreachable');
  });
});

describe('adopt flow', () => {
  function adoptFixture() {
    const config = tempConfig();
    const events = createEventBus();
    const profiles = createProfileService(config, events);
    const remote = createFakeRemoteTransport({
      profiles: [
        { id: 'remote-1', provider: 'claude', label: 'work', status: 'active', enabled: true },
      ],
    });
    remote.scriptExec(['apm', 'profile', 'sync-enable', 'remote-1'], {
      stdout: `${JSON.stringify({ syncId: SYNC_ID, role: 'owner' })}\n`,
    });
    remote.setBundle(SYNC_ID, claudeBundle('adopted-token', T1));
    const targets = createTargetRegistry(
      createLocalTransport({ profiles, shimsDir: config.shimsDir }),
      [remote],
    );
    return { config, profiles, targets, remote };
  }

  it('adopts a remote profile end to end: enable on owner, pull, replica with credentials', async () => {
    const { config, profiles, targets, remote } = adoptFixture();

    const profile = await adoptProfile(
      { config, profiles, targets },
      { targetId: remote.target.id, provider: 'claude', remoteProfileId: 'remote-1' },
    );

    expect(profile).toMatchObject({
      provider: 'claude',
      label: 'work',
      homeKind: 'managed',
      status: 'active',
      sync: { id: SYNC_ID, role: 'replica' },
    });
    expect(remote.execs[0]?.spec.argv).toEqual(['apm', 'profile', 'sync-enable', 'remote-1']);
    const written = JSON.parse(
      fs.readFileSync(path.join(profile.home, '.credentials.json'), 'utf8'),
    );
    expect(written).toEqual({ claudeAiOauth: { accessToken: 'adopted-token' } });
    // Reload survives the schema round-trip.
    const reloaded = createProfileService(config, createEventBus());
    expect(reloaded.get(profile.id)?.sync).toEqual({ id: SYNC_ID, role: 'replica' });
  });

  it('refuses a second adoption of the same sync id and cleans up the fresh home', async () => {
    const { config, profiles, targets, remote } = adoptFixture();
    await adoptProfile(
      { config, profiles, targets },
      { targetId: remote.target.id, provider: 'claude', remoteProfileId: 'remote-1' },
    );
    const homesBefore = fs.readdirSync(config.homesDir);
    await expect(
      adoptProfile(
        { config, profiles, targets },
        { targetId: remote.target.id, provider: 'claude', remoteProfileId: 'remote-1' },
      ),
    ).rejects.toMatchObject({ code: 'already-synced' });
    expect(fs.readdirSync(config.homesDir)).toEqual(homesBefore);
  });

  it('rejects providers without sync support and provider mismatches', async () => {
    const { config, profiles, targets, remote } = adoptFixture();
    await expect(
      adoptProfile(
        { config, profiles, targets },
        { targetId: remote.target.id, provider: 'cursor', remoteProfileId: 'remote-1' },
      ),
    ).rejects.toMatchObject({ code: 'sync-unsupported' });
    await expect(
      adoptProfile(
        { config, profiles, targets },
        { targetId: remote.target.id, provider: 'codex', remoteProfileId: 'remote-1' },
      ),
    ).rejects.toMatchObject({ code: 'provider-mismatch' });
  });

  it('keeps remote stderr and remote error text out of API failures', async () => {
    const { config, profiles, targets, remote } = adoptFixture();
    remote.scriptExec(['apm', 'profile', 'sync-enable', 'remote-1'], {
      exitCode: 1,
      stderr: 'apm: Authorization: Bearer sk-SECRET-material',
    });
    const enableFailure = await adoptProfile(
      { config, profiles, targets },
      { targetId: remote.target.id, provider: 'claude', remoteProfileId: 'remote-1' },
    ).catch((error: unknown) => error as ApiFailure);
    expect(enableFailure).toMatchObject({ code: 'sync-enable-failed' });
    expect((enableFailure as ApiFailure).message).not.toContain('sk-SECRET');

    remote.scriptExec(['apm', 'profile', 'sync-enable', 'remote-1'], {
      stdout: `${JSON.stringify({ syncId: SYNC_ID, role: 'owner' })}\n`,
    });
    remote.scriptSyncFailure('sync-not-enabled', 'echoed remote text sk-SECRET-material');
    const pullFailure = await adoptProfile(
      { config, profiles, targets },
      { targetId: remote.target.id, provider: 'claude', remoteProfileId: 'remote-1' },
    ).catch((error: unknown) => error as ApiFailure);
    expect(pullFailure).toMatchObject({ code: 'sync-not-enabled' });
    expect((pullFailure as ApiFailure).message).not.toContain('sk-SECRET');
  });

  it('fails loudly when sync-enable on the target prints no sync id', async () => {
    const { config, profiles, targets, remote } = adoptFixture();
    remote.scriptExec(['apm', 'profile', 'sync-enable', 'remote-1'], { stdout: 'garbage\n' });
    await expect(
      adoptProfile(
        { config, profiles, targets },
        { targetId: remote.target.id, provider: 'claude', remoteProfileId: 'remote-1' },
      ),
    ).rejects.toMatchObject({ code: 'sync-enable-failed' });
    expect(fs.existsSync(config.homesDir) ? fs.readdirSync(config.homesDir) : []).toEqual([]);
  });

  it('maps an unapproved target to the transport approval failure', async () => {
    const { config, profiles, targets, remote } = adoptFixture();
    remote.setApproved(false);
    await expect(
      adoptProfile(
        { config, profiles, targets },
        { targetId: remote.target.id, provider: 'claude', remoteProfileId: 'remote-1' },
      ),
    ).rejects.toBeInstanceOf(ApiFailure);
  });
});
