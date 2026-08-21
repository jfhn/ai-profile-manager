import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CollectResult, Profile, ProviderId, ProviderIdentity } from '@apm/shared';
import type { ProviderAdapter } from '@apm/collectors';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureDirs, resolveConfig } from '../config.js';
import { ApiFailure } from '../context.js';
import { createEventBus } from './events.js';
import { profileCacheDirectory } from './profilePaths.js';
import { createProfileService, type AdapterRegistry } from './profiles.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('profile service', () => {
  it('lists providers with defaultApp from loginArgv', () => {
    const service = createProfileService(tempConfig(), createEventBus(), fakeAdapters());
    expect(service.providers()).toEqual([
      expect.objectContaining({ id: 'claude', label: 'Claude', defaultApp: 'claude' }),
      expect.objectContaining({ id: 'codex', label: 'Codex', defaultApp: 'codex' }),
      expect.objectContaining({ id: 'cursor', label: 'Cursor', defaultApp: 'cursor-agent' }),
    ]);
  });

  it('persists adoption, renames, uniqueness, and managed purges', async () => {
    const config = tempConfig();
    const service = createProfileService(config, createEventBus(), fakeAdapters());
    const firstHome = makeHome(config.dataDir, 'first', true);
    const secondHome = makeHome(config.dataDir, 'second', true);

    const first = await service.create({ provider: 'claude', label: 'Work', home: firstHome });
    expect(first).toMatchObject({
      homeKind: 'external',
      status: 'active',
      statusReason: null,
    });
    expect(service.defaults()).toEqual({ claude: first.id });
    await expect(
      service.create({ provider: 'claude', label: 'work', home: secondHome }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'label-taken' });
    await expect(
      service.create({ provider: 'claude', label: 'Other', home: firstHome }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'home-taken' });

    const otherProvider = await service.create({
      provider: 'codex',
      label: 'work',
      home: secondHome,
    });
    expect(otherProvider.label).toBe('work');
    expect(service.defaults()).toEqual({ claude: first.id, codex: otherProvider.id });
    expect(service.update(first.id, { label: 'Personal', enabled: false })).toMatchObject({
      label: 'Personal',
      enabled: false,
    });
    expect(service.defaults()).toEqual({ codex: otherProvider.id });

    const managedHome = path.join(config.homesDir, 'adopted-managed');
    fs.mkdirSync(managedHome, { mode: 0o700 });
    const managed = await service.create({
      provider: 'claude',
      label: 'Managed',
      home: managedHome,
    });
    const cache = profileCacheDirectory(config.cacheDir, managed.id);
    fs.mkdirSync(cache);
    await service.remove(managed.id, true);
    expect(fs.existsSync(managedHome)).toBe(false);
    expect(fs.existsSync(cache)).toBe(false);

    await expect(service.remove(first.id, true)).rejects.toBeInstanceOf(ApiFailure);
    expect(service.get(first.id)).not.toBeNull();

    const reloaded = createProfileService(config, createEventBus(), fakeAdapters());
    expect(reloaded.list().map((profile) => profile.label)).toEqual(['Personal', 'work']);
    expect(fs.statSync(config.profilesFile).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(config.profilesFile, 'utf8')).toContain('\n  "version": 2,\n');
  });

  it('enables sync once, survives a reload, and keeps sync out of create/update', async () => {
    const config = tempConfig();
    const service = createProfileService(config, createEventBus(), syncCapableAdapters());
    const home = makeHome(config.dataDir, 'work', true);
    const created = await service.create({ provider: 'claude', label: 'work', home });
    expect(created.sync).toBeNull();

    const enabled = service.enableSync(created.id);
    expect(enabled.sync).toMatchObject({ role: 'owner' });
    // Idempotent: the same sync id, no rotation of identity.
    expect(service.enableSync(created.id).sync).toEqual(enabled.sync);

    const reloaded = createProfileService(config, createEventBus(), syncCapableAdapters());
    expect(reloaded.get(created.id)?.sync).toEqual(enabled.sync);
  });

  it('refuses sync for providers without credentialSync and for inactive profiles', async () => {
    const config = tempConfig();
    const service = createProfileService(config, createEventBus(), syncCapableAdapters());
    const cursorProfile = await service.create({
      provider: 'cursor',
      label: 'no-sync',
      home: makeHome(config.dataDir, 'cursor', true),
    });
    expect(() => service.enableSync(cursorProfile.id)).toThrow('does not support credential sync');

    const broken = await service.create({
      provider: 'claude',
      label: 'broken',
      home: makeHome(config.dataDir, 'broken', false),
    });
    expect(broken.status).toBe('error');
    expect(() => service.enableSync(broken.id)).toThrow('Only active profiles');
  });

  it('creates replicas only via createReplica and rejects duplicate sync ids', async () => {
    const config = tempConfig();
    const service = createProfileService(config, createEventBus(), syncCapableAdapters());
    const sync = { id: '11111111-2222-4333-8444-555555555555', role: 'replica' as const };
    const replica = await service.createReplica({
      provider: 'claude',
      label: 'work',
      home: makeHome(config.dataDir, 'replica', true),
      sync,
    });
    expect(replica).toMatchObject({ status: 'active', sync });

    await expect(
      service.createReplica({
        provider: 'claude',
        label: 'work-2',
        home: makeHome(config.dataDir, 'replica-2', true),
        sync,
      }),
    ).rejects.toMatchObject({ code: 'already-synced' });
  });

  it('rolls back the in-memory sync state when the persist fails', async () => {
    const config = tempConfig();
    const service = createProfileService(config, createEventBus(), syncCapableAdapters());
    const created = await service.create({
      provider: 'claude',
      label: 'work',
      home: makeHome(config.dataDir, 'work', true),
    });

    // Make the next persist fail: the store path becomes a directory.
    fs.rmSync(config.profilesFile);
    fs.mkdirSync(config.profilesFile);
    expect(() => service.enableSync(created.id)).toThrow();
    expect(service.get(created.id)?.sync).toBeNull();

    await expect(
      service.createReplica({
        provider: 'claude',
        label: 'replica',
        home: makeHome(config.dataDir, 'replica', true),
        sync: { id: '11111111-2222-4333-8444-555555555555', role: 'replica' },
      }),
    ).rejects.toThrow();
    expect(service.list().map((profile) => profile.label)).toEqual(['work']);
  });

  it('rejects a persisted store where two profiles share a sync id', () => {
    const config = tempConfig();
    const sync = { id: '11111111-2222-4333-8444-555555555555', role: 'owner' as const };
    fs.writeFileSync(
      config.profilesFile,
      JSON.stringify({
        version: 2,
        profiles: [
          storedProfile({ id: 'p1', label: 'first', home: '/tmp/first-home', sync }),
          storedProfile({
            id: 'p2',
            label: 'second',
            home: '/tmp/second-home',
            sync: { ...sync, role: 'replica' },
          }),
        ],
      }),
    );
    expect(() => createProfileService(config, createEventBus(), fakeAdapters())).toThrow(
      'sync.id duplicates',
    );
  });

  it('rejects an invalid persisted store instead of replacing it', () => {
    const config = tempConfig();
    fs.writeFileSync(config.profilesFile, '{"version":3,"profiles":[]}');
    expect(() => createProfileService(config, createEventBus(), fakeAdapters())).toThrow(
      `Invalid profile store at ${config.profilesFile}`,
    );
    expect(fs.readFileSync(config.profilesFile, 'utf8')).toContain('"version":3');
  });

  it.each([1, 2] as const)(
    'rejects duplicate profile ids in a v%s store without rewriting it',
    (version) => {
      const config = tempConfig();
      const profiles = [
        storedProfile({ id: 'duplicate', label: 'first', home: '/tmp/first-home' }),
        storedProfile({ id: 'duplicate', label: 'second', home: '/tmp/second-home' }),
      ];
      const original = JSON.stringify({
        version,
        profiles,
        ...(version === 2 ? { defaultProfileIds: { claude: 'duplicate' } } : {}),
      });
      fs.writeFileSync(config.profilesFile, original);

      expect(() => createProfileService(config, createEventBus(), fakeAdapters())).toThrow(
        /profiles\[1\]\.id duplicates profiles\[0\]\.id \("duplicate"\)/,
      );
      expect(fs.readFileSync(config.profilesFile, 'utf8')).toBe(original);
    },
  );

  it.each([
    {
      field: 'label',
      first: storedProfile({ id: 'first', label: 'Work', home: '/tmp/first-home' }),
      second: storedProfile({ id: 'second', label: 'work', home: '/tmp/second-home' }),
    },
    {
      field: 'home',
      first: storedProfile({ id: 'first', label: 'first', home: '/tmp/shared-home' }),
      second: storedProfile({ id: 'second', label: 'second', home: '/tmp/shared-home' }),
    },
  ])(
    'rejects persisted duplicate provider+$field pairs without rewriting',
    ({ field, first, second }) => {
      const config = tempConfig();
      const original = JSON.stringify({ version: 1, profiles: [first, second] });
      fs.writeFileSync(config.profilesFile, original);

      expect(() => createProfileService(config, createEventBus(), fakeAdapters())).toThrow(
        new RegExp(
          `profiles\\[1\\]\\.${field} duplicates profiles\\[0\\]\\.${field} for provider claude`,
        ),
      );
      expect(fs.readFileSync(config.profilesFile, 'utf8')).toBe(original);
    },
  );

  it('allows the same persisted label and home for different providers', () => {
    const config = tempConfig();
    fs.writeFileSync(
      config.profilesFile,
      JSON.stringify({
        version: 1,
        profiles: [
          storedProfile({ id: 'claude', provider: 'claude' }),
          storedProfile({ id: 'codex', provider: 'codex' }),
        ],
      }),
    );

    expect(createProfileService(config, createEventBus(), fakeAdapters()).list()).toHaveLength(2);
  });

  it('migrates v1 stores and promotes the alphabetically first eligible default', () => {
    const config = tempConfig();
    const profiles = [
      storedProfile({
        id: 'claude-work',
        provider: 'claude',
        label: 'work',
        home: '/tmp/claude-work',
      }),
      storedProfile({
        id: 'claude-other',
        provider: 'claude',
        label: 'other',
        home: '/tmp/claude-other',
      }),
      storedProfile({
        id: 'codex-work',
        provider: 'codex',
        label: 'work',
        home: '/tmp/codex-work',
      }),
      storedProfile({
        id: 'codex-disabled',
        provider: 'codex',
        label: 'disabled',
        home: '/tmp/codex-disabled',
        enabled: false,
      }),
    ];
    fs.writeFileSync(config.profilesFile, JSON.stringify({ version: 1, profiles }));

    const service = createProfileService(config, createEventBus(), fakeAdapters());

    // 'other' sorts before 'work'; the disabled codex profile is skipped.
    expect(service.defaults()).toEqual({ claude: 'claude-other', codex: 'codex-work' });
    expect(JSON.parse(fs.readFileSync(config.profilesFile, 'utf8'))).toMatchObject({
      version: 2,
      defaultProfileIds: { claude: 'claude-other', codex: 'codex-work' },
    });
  });

  it('normalizes relative homes in v1 and v2 stores before exposing or persisting them', () => {
    for (const version of [1, 2] as const) {
      const config = tempConfig();
      const id = `relative-${version}`;
      const relativeHome = path.join('legacy-relative-data', 'homes', id);
      const store = {
        version,
        profiles: [storedProfile({ id, home: relativeHome })],
        ...(version === 2 ? { defaultProfileIds: { claude: id } } : {}),
      };
      fs.writeFileSync(config.profilesFile, JSON.stringify(store));

      const service = createProfileService(config, createEventBus(), fakeAdapters());
      const expectedHome = path.resolve(relativeHome);

      expect(service.get(id)?.home).toBe(expectedHome);
      expect(path.isAbsolute(service.get(id)?.home ?? '')).toBe(true);
      expect(JSON.parse(fs.readFileSync(config.profilesFile, 'utf8'))).toMatchObject({
        version: 2,
        profiles: [{ id, home: expectedHome }],
        defaultProfileIds: { claude: id },
      });
    }
  });

  it('keeps opaque punctuation, slash, edge whitespace, and Unicode ids through migration', () => {
    const config = tempConfig();
    const id = ' work/個人 ! ';
    fs.writeFileSync(
      config.profilesFile,
      JSON.stringify({ version: 1, profiles: [storedProfile({ id })] }),
    );

    const service = createProfileService(config, createEventBus(), fakeAdapters());

    expect(service.get(id)?.id).toBe(id);
    expect(service.defaults()).toEqual({ claude: id });
    expect(JSON.parse(fs.readFileSync(config.profilesFile, 'utf8'))).toMatchObject({
      profiles: [{ id }],
      defaultProfileIds: { claude: id },
    });
  });

  it('enforces the shared profile-id byte and control bounds without replacing the store', () => {
    const accepted = `${'é'.repeat(127)}ab`;
    expect(Buffer.byteLength(accepted, 'utf8')).toBe(256);
    const config = tempConfig();
    fs.writeFileSync(
      config.profilesFile,
      JSON.stringify({
        version: 2,
        profiles: [storedProfile({ id: accepted })],
        defaultProfileIds: { claude: accepted },
      }),
    );
    expect(createProfileService(config, createEventBus(), fakeAdapters()).defaults()).toEqual({
      claude: accepted,
    });

    for (const invalidId of [`${accepted}a`, 'profile\u0000id', ' \t ']) {
      const original = JSON.stringify({
        version: 2,
        profiles: [storedProfile({ id: invalidId, home: 'relative-invalid-home' })],
        defaultProfileIds: { claude: invalidId },
      });
      fs.writeFileSync(config.profilesFile, original);

      expect(() => createProfileService(config, createEventBus(), fakeAdapters())).toThrow(
        `Invalid profile store at ${config.profilesFile}`,
      );
      expect(fs.readFileSync(config.profilesFile, 'utf8')).toBe(original);
    }
  });

  it('rejects invalid default ids with the same opaque-id rule', () => {
    const config = tempConfig();
    const original = JSON.stringify({
      version: 2,
      profiles: [storedProfile({ id: 'valid' })],
      defaultProfileIds: { claude: 'bad\nvalue' },
    });
    fs.writeFileSync(config.profilesFile, original);

    expect(() => createProfileService(config, createEventBus(), fakeAdapters())).toThrow(
      `Invalid profile store at ${config.profilesFile}`,
    );
    expect(fs.readFileSync(config.profilesFile, 'utf8')).toBe(original);
  });

  it('does not let normalized legacy managed homes weaken purge containment', async () => {
    const config = tempConfig();
    const outside = makeHome(config.dataDir, 'outside-managed', true);
    const marker = path.join(outside, 'keep-me');
    fs.writeFileSync(marker, 'safe');
    const relativeOutside = path.relative(process.cwd(), outside);
    fs.writeFileSync(
      config.profilesFile,
      JSON.stringify({
        version: 2,
        profiles: [
          storedProfile({ id: 'legacy-managed', home: relativeOutside, homeKind: 'managed' }),
        ],
        defaultProfileIds: { claude: 'legacy-managed' },
      }),
    );
    const service = createProfileService(config, createEventBus(), fakeAdapters());

    expect(service.get('legacy-managed')?.home).toBe(path.resolve(relativeOutside));
    await expect(service.remove('legacy-managed', true)).rejects.toMatchObject({
      code: 'unsafe-home',
    });
    expect(fs.readFileSync(marker, 'utf8')).toBe('safe');
  });

  it('preserves explicit defaults on rename and promotes a replacement on disable or removal', async () => {
    const config = tempConfig();
    const service = createProfileService(config, createEventBus(), fakeAdapters());
    const first = await service.create({
      provider: 'claude',
      label: 'first',
      home: makeHome(config.dataDir, 'default-first', true),
    });
    const second = await service.create({
      provider: 'claude',
      label: 'second',
      home: makeHome(config.dataDir, 'default-second', true),
    });

    expect(service.defaults()).toEqual({ claude: first.id });
    service.setDefault('claude', second.id);
    service.update(second.id, { label: 'renamed' });
    expect(service.defaults()).toEqual({ claude: second.id });

    // Disabling the default promotes the alphabetically first eligible
    // profile; re-enabling does not steal the default back.
    service.update(second.id, { enabled: false });
    expect(service.defaults()).toEqual({ claude: first.id });
    service.update(second.id, { enabled: true });
    expect(service.defaults()).toEqual({ claude: first.id });

    await service.remove(first.id, false);
    expect(service.defaults()).toEqual({ claude: second.id });

    // Only a provider with no eligible profiles is left without a default.
    service.update(second.id, { enabled: false });
    expect(service.defaults()).toEqual({});
  });

  it('promotes the alphabetically first eligible profile and survives a reload', async () => {
    const config = tempConfig();
    const service = createProfileService(config, createEventBus(), fakeAdapters());
    const zeta = await service.create({
      provider: 'claude',
      label: 'zeta',
      home: makeHome(config.dataDir, 'promotion-zeta', true),
    });
    const alpha = await service.create({
      provider: 'claude',
      label: 'alpha',
      home: makeHome(config.dataDir, 'promotion-alpha', true),
    });
    const mid = await service.create({
      provider: 'claude',
      label: 'mid',
      home: makeHome(config.dataDir, 'promotion-mid', true),
    });

    // The first created profile became default; removing it promotes 'alpha',
    // not the next-created one.
    await service.remove(zeta.id, false);
    expect(service.defaults()).toEqual({ claude: alpha.id });

    service.update(alpha.id, { enabled: false });
    expect(service.defaults()).toEqual({ claude: mid.id });

    const reloaded = createProfileService(config, createEventBus(), fakeAdapters());
    expect(reloaded.defaults()).toEqual({ claude: mid.id });
  });

  it('validates default provider, state, and persisted references', async () => {
    const config = tempConfig();
    const service = createProfileService(config, createEventBus(), fakeAdapters());
    const claude = await service.create({
      provider: 'claude',
      label: 'claude',
      home: makeHome(config.dataDir, 'validation-claude', true),
    });
    const broken = await service.create({
      provider: 'codex',
      label: 'broken',
      home: makeHome(config.dataDir, 'validation-broken', false),
    });

    expect(() => service.setDefault('codex', claude.id)).toThrow(/does not belong/);
    expect(() => service.setDefault('codex', broken.id)).toThrow(/active and enabled/);
    // Clearing recomputes: with an eligible profile there is no "no default".
    service.setDefault('claude', null);
    expect(service.defaults()).toEqual({ claude: claude.id });

    fs.writeFileSync(
      config.profilesFile,
      JSON.stringify({
        version: 2,
        profiles: [storedProfile({ id: 'disabled', enabled: false })],
        defaultProfileIds: { claude: 'disabled' },
      }),
    );
    expect(() => createProfileService(config, createEventBus(), fakeAdapters())).toThrow(
      /default for claude must reference an active, enabled claude profile/,
    );
  });

  it('merges a partial identity detection into the stored one', () => {
    const config = tempConfig();
    const home = makeHome(config.dataDir, 'identity-sweep', true);
    fs.writeFileSync(
      config.profilesFile,
      JSON.stringify({
        version: 2,
        profiles: [
          storedProfile({
            id: 'claude-profile',
            home,
            identity: { account: 'alice@example.test', organization: 'Acme', plan: null },
          }),
        ],
        defaultProfileIds: { claude: 'claude-profile' },
      }),
    );

    const service = createProfileService(config, createEventBus(), fakeAdapters());
    service.refreshIdentities();

    // The adapter detects no organization, which must not erase the stored one.
    const expected = { account: 'alice@example.test', organization: 'Acme', plan: 'pro' };
    expect(service.get('claude-profile')?.identity).toEqual(expected);
    const persisted = JSON.parse(fs.readFileSync(config.profilesFile, 'utf8'));
    expect(persisted.profiles[0].identity).toEqual(expected);
  });

  it('replaces the stored identity when the detected account is a different login', () => {
    const config = tempConfig();
    const home = makeHome(config.dataDir, 'identity-switch', true);
    fs.writeFileSync(
      config.profilesFile,
      JSON.stringify({
        version: 2,
        profiles: [
          storedProfile({
            id: 'claude-profile',
            home,
            identity: { account: 'old@example.test', organization: 'Acme', plan: 'team' },
          }),
        ],
        defaultProfileIds: { claude: 'claude-profile' },
      }),
    );

    const service = createProfileService(config, createEventBus(), fakeAdapters());
    service.refreshIdentities();

    expect(service.get('claude-profile')?.identity).toEqual({
      account: 'alice@example.test',
      organization: null,
      plan: 'pro',
    });
  });

  it('runs the prepare-login wizard without handling credentials', async () => {
    const config = tempConfig();
    const service = createProfileService(config, createEventBus(), fakeAdapters());

    const started = await service.startWizard('claude');
    expect(started).toMatchObject({
      credentialsFound: false,
      identity: null,
      suggestedLabel: '',
    });
    expect(started.profile).toMatchObject({
      label: 'new-claude',
      status: 'pending',
      homeKind: 'managed',
    });
    expect(fs.statSync(started.profile.home).mode & 0o777).toBe(0o700);
    await expect(service.confirmWizard(started.profile.id, 'alice')).rejects.toMatchObject({
      statusCode: 409,
      code: 'no-credentials',
    });

    fs.writeFileSync(path.join(started.profile.home, 'credentials'), 'secret test credential');
    const ready = await service.wizardState(started.profile.id);
    expect(ready).toMatchObject({
      credentialsFound: true,
      suggestedLabel: 'alice',
      identity: { account: 'alice@example.test' },
    });
    const confirmed = await service.confirmWizard(started.profile.id, ready.suggestedLabel);
    expect(confirmed).toMatchObject({
      label: 'alice',
      status: 'active',
      statusReason: null,
      identity: { account: 'alice@example.test' },
    });
    expect(service.defaults()).toEqual({ claude: confirmed.id });
  });
});

function storedProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: 'claude-profile',
    provider: 'claude',
    label: 'profile',
    home: '/tmp/profile-home',
    homeKind: 'external',
    identity: null,
    status: 'active',
    statusReason: null,
    enabled: true,
    sync: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function tempConfig() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-profiles-test-'));
  temporaryDirectories.push(directory);
  const config = resolveConfig({ dataDir: directory });
  ensureDirs(config);
  return config;
}

function makeHome(parent: string, name: string, credentials: boolean): string {
  const home = path.join(parent, `external-${name}`);
  fs.mkdirSync(home);
  if (credentials) fs.writeFileSync(path.join(home, 'credentials'), 'secret test credential');
  return home;
}

function fakeAdapters(): AdapterRegistry {
  return {
    claude: fakeAdapter('claude'),
    codex: fakeAdapter('codex'),
    cursor: fakeAdapter('cursor'),
  };
}

/** fakeAdapters, but claude and codex carry the sync capability marker. */
function syncCapableAdapters(): AdapterRegistry {
  const base = fakeAdapters();
  const support = {
    credentialFile: (home: string) => path.join(home, 'credentials'),
    readBundle: async () => null,
    writeBundle: async () => 'stale' as const,
  };
  return {
    ...base,
    claude: { ...base.claude, credentialSync: support },
    codex: { ...base.codex, credentialSync: support },
  };
}

function fakeAdapter(provider: ProviderId): ProviderAdapter {
  const names = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor' } as const;
  const defaultApp = provider === 'cursor' ? 'cursor-agent' : provider;
  return {
    provider,
    displayName: names[provider],
    capabilities: { usage: true, usageSources: ['local-files'], identity: true, windows: [] },
    hasCredentials: (home) => fs.existsSync(path.join(home, 'credentials')),
    detectIdentity: (home): ProviderIdentity | null =>
      fs.existsSync(path.join(home, 'credentials'))
        ? { account: 'alice@example.test', organization: null, plan: 'pro' }
        : null,
    collectUsage: async (): Promise<CollectResult> => emptyResult(),
    env: (home) => ({ session: { [`${provider.toUpperCase()}_HOME`]: home }, appOnly: null }),
    loginCommand: (home) => `${provider.toUpperCase()}_HOME=${home} ${defaultApp} login`,
    loginArgv: () => [defaultApp, 'login'],
    defaultHome: () => path.join(os.tmpdir(), `missing-${provider}`),
  };
}

function emptyResult(): CollectResult {
  return {
    windows: [],
    source: 'test',
    cacheStatus: 'live',
    dataUpdatedAt: null,
    stale: false,
    staleReason: null,
    failureKind: null,
    error: null,
    planType: null,
    retryAfterSeconds: null,
  };
}
