/**
 * Registry behavior plus the failures only a remote target has: an
 * unapproved machine, an unreachable machine and a closed connection.
 */
import { describe, expect, it } from 'vitest';
import { LOCAL_TARGET_ID, type Profile, type TargetProfileSummary } from '@apm/shared';
import type { ProfileService } from '../context.js';
import { resolveProfile } from '../cli/parse.js';
import { ApiFailure } from '../context.js';
import { toApiFailure } from './errors.js';
import { createLocalTransport } from './local.js';
import { createTargetRegistry } from './registry.js';
import { createFakeRemoteTransport } from './test-support/fake-remote.js';

const LOCAL_PROFILE: Profile = {
  id: 'local-1',
  provider: 'claude',
  label: 'work',
  home: '/tmp/apm-registry-home',
  homeKind: 'external',
  identity: null,
  status: 'active',
  statusReason: null,
  enabled: true,
  createdAt: new Date().toISOString(),
};

const REMOTE_PROFILE: TargetProfileSummary = {
  id: 'remote-1',
  provider: 'claude',
  label: 'workstation',
  status: 'active',
  enabled: true,
};

function localProfiles(): Pick<ProfileService, 'list' | 'envFor'> {
  return { list: () => [LOCAL_PROFILE], envFor: () => ({ CLAUDE_CONFIG_DIR: LOCAL_PROFILE.home }) };
}

function harness(options: { approved?: boolean } = {}) {
  const local = createLocalTransport({ profiles: localProfiles() });
  const remote = createFakeRemoteTransport({
    id: 'workshop',
    approved: options.approved ?? true,
    profiles: [REMOTE_PROFILE],
  });
  const registry = createTargetRegistry(local, [remote]);
  return { local, remote, registry };
}

describe('target registry', () => {
  it('resolves the local target when nothing is selected', () => {
    const { local, registry } = harness();
    expect(registry.transportFor()).toBe(local);
    expect(registry.transportFor(null)).toBe(local);
    expect(registry.transportFor(LOCAL_TARGET_ID)).toBe(local);
    expect(registry.get()?.kind).toBe('local');
    expect(registry.list().map((target) => target.id)).toEqual([LOCAL_TARGET_ID, 'workshop']);
  });

  it('fails on an unknown target', () => {
    const { registry } = harness();
    expect(() => registry.transportFor('nope')).toThrowError(/No target "nope"/);
    expect(registry.get('nope')).toBeNull();
    try {
      registry.transportFor('nope');
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: 'target-not-found', targetId: 'nope' });
    }
  });

  it('refuses a remote target nobody approved', () => {
    const { registry, remote } = harness({ approved: false });
    expect(() => registry.transportFor('workshop')).toThrowError(/not approved/);
    remote.setApproved(true);
    expect(registry.transportFor('workshop')).toBe(remote);
  });

  it('never lets the local target be replaced', () => {
    const { registry } = harness();
    const impostor = createFakeRemoteTransport({ id: LOCAL_TARGET_ID });
    expect(() => registry.register(impostor)).toThrowError(/cannot be replaced/);
  });

  it('scopes profile resolution to one target', async () => {
    const { registry } = harness();
    expect(await registry.profiles()).toEqual([
      { id: 'local-1', provider: 'claude', label: 'work', status: 'active', enabled: true },
    ]);
    expect(await registry.profiles('workshop')).toEqual([REMOTE_PROFILE]);

    expect(await registry.resolveProfile('workshop', 'remote-1')).toEqual(REMOTE_PROFILE);
    // A local profile id means nothing on the remote machine.
    await expect(registry.resolveProfile('workshop', 'local-1')).rejects.toMatchObject({
      code: 'profile-not-found',
      targetId: 'workshop',
    });
  });

  it('resolves profile names against the selected target only', async () => {
    const { registry } = harness();
    const remote = await registry.profiles('workshop');
    expect(resolveProfile(remote, 'workstation', 'claude').id).toBe('remote-1');
    expect(() => resolveProfile(remote, 'work', 'claude')).toThrowError(/no profile named "work"/);

    const local = await registry.profiles();
    expect(resolveProfile(local, 'work', 'claude').id).toBe('local-1');
  });

  it('surfaces an unreachable target instead of hanging', async () => {
    const { registry, remote } = harness();
    remote.setOnline(false);
    expect(await registry.transportFor('workshop').probe()).toBe('offline');
    await expect(registry.profiles('workshop')).rejects.toMatchObject({ code: 'unreachable' });
    await expect(registry.transportFor('workshop').exec({ argv: ['true'] })).rejects.toMatchObject({
      code: 'unreachable',
    });
  });

  it('closes remote connections and rejects work afterwards', async () => {
    const { registry, remote } = harness();
    const endpoint = await remote.openEndpoint({ port: null });
    await registry.close();

    expect(remote.lastEndpoint().closed).toBe(true);
    expect((await endpoint.health()).state).toBe('closed');
    await expect(remote.exec({ argv: ['true'] })).rejects.toMatchObject({ code: 'closed' });
    // The local transport keeps working: closing releases connections only.
    expect((await registry.profiles()).length).toBe(1);
  });

  it('reports an unsupported capability rather than pretending', async () => {
    const remote = createFakeRemoteTransport({ id: 'exec-only', capabilities: ['exec'] });
    const registry = createTargetRegistry(createLocalTransport({ profiles: localProfiles() }), [
      remote,
    ]);
    expect(registry.transportFor('exec-only').supports('pty')).toBe(false);
    await expect(
      registry.transportFor('exec-only').openPty({ argv: ['sh'], cols: 80, rows: 24 }),
    ).rejects.toMatchObject({ code: 'unsupported' });
  });
});

describe('transport error mapping', () => {
  it('keeps the session error codes and maps target failures to HTTP', () => {
    const { registry } = harness({ approved: false });
    const failure = (thrown: unknown): ApiFailure => {
      try {
        return toApiFailure(thrown);
      } catch {
        throw new Error('expected a transport error');
      }
    };

    let notApproved: unknown;
    try {
      registry.transportFor('workshop');
    } catch (error: unknown) {
      notApproved = error;
    }
    const mapped = failure(notApproved);
    expect(mapped).toBeInstanceOf(ApiFailure);
    expect(mapped.statusCode).toBe(403);
    expect(mapped.code).toBe('target-not-approved');
  });

  it('rethrows anything that is not a transport error', () => {
    const boom = new Error('boom');
    expect(() => toApiFailure(boom)).toThrowError(boom);
  });
});
