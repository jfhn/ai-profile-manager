import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CollectResult, ProviderId, ProviderIdentity } from '@apm/shared';
import type { ProviderAdapter } from '@apm/collectors';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureDirs, resolveConfig } from '../config.js';
import { ApiFailure } from '../context.js';
import { createEventBus } from './events.js';
import { createProfileService, type AdapterRegistry } from './profiles.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('profile service', () => {
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
    expect(service.update(first.id, { label: 'Personal', enabled: false })).toMatchObject({
      label: 'Personal',
      enabled: false,
    });

    const managedHome = path.join(config.homesDir, 'adopted-managed');
    fs.mkdirSync(managedHome, { mode: 0o700 });
    const managed = await service.create({
      provider: 'claude',
      label: 'Managed',
      home: managedHome,
    });
    const cache = path.join(config.cacheDir, managed.id);
    fs.mkdirSync(cache);
    await service.remove(managed.id, true);
    expect(fs.existsSync(managedHome)).toBe(false);
    expect(fs.existsSync(cache)).toBe(false);

    await expect(service.remove(first.id, true)).rejects.toBeInstanceOf(ApiFailure);
    expect(service.get(first.id)).not.toBeNull();

    const reloaded = createProfileService(config, createEventBus(), fakeAdapters());
    expect(reloaded.list().map((profile) => profile.label)).toEqual(['Personal', 'work']);
    expect(fs.statSync(config.profilesFile).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(config.profilesFile, 'utf8')).toContain('\n  "profiles": [\n');
  });

  it('rejects an invalid persisted store instead of replacing it', () => {
    const config = tempConfig();
    fs.writeFileSync(config.profilesFile, '{"version":2,"profiles":[]}');
    expect(() => createProfileService(config, createEventBus(), fakeAdapters())).toThrow(
      `Invalid profile store at ${config.profilesFile}`,
    );
    expect(fs.readFileSync(config.profilesFile, 'utf8')).toContain('"version":2');
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
  });
});

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
  };
}

function fakeAdapter(provider: ProviderId): ProviderAdapter {
  return {
    provider,
    displayName: provider === 'claude' ? 'Claude' : 'Codex',
    capabilities: { usage: true, usageSources: ['local-files'], identity: true, windows: [] },
    hasCredentials: (home) => fs.existsSync(path.join(home, 'credentials')),
    detectIdentity: (home): ProviderIdentity | null =>
      fs.existsSync(path.join(home, 'credentials'))
        ? { account: 'alice@example.test', organization: null, plan: 'pro' }
        : null,
    collectUsage: async (): Promise<CollectResult> => emptyResult(),
    env: (home) => ({ [`${provider.toUpperCase()}_HOME`]: home }),
    loginCommand: (home) => `${provider.toUpperCase()}_HOME=${home} ${provider} login`,
    loginArgv: () => [provider, 'login'],
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
