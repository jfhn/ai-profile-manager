import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProviderAdapter } from '@apm/collectors';
import type { CollectResult, ProviderId, ProviderIdentity } from '@apm/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureDirs, resolveConfig } from '../config.js';
import { createEventBus } from './events.js';
import { createProfileService, type AdapterRegistry } from './profiles.js';
import { createUsageService } from './usage.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('usage service', () => {
  it('isolates adapter failures, persists snapshots, and seeds a fresh service', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-usage-test-'));
    temporaryDirectories.push(directory);
    const config = resolveConfig({ dataDir: directory });
    ensureDirs(config);
    const successfulCollect = vi.fn(async (): Promise<CollectResult> => cannedResult());
    const failingCollect = vi.fn(async (): Promise<CollectResult> => {
      throw new Error('provider failed with access_token=top-secret');
    });
    const adapters: AdapterRegistry = {
      claude: fakeAdapter('claude', failingCollect),
      codex: fakeAdapter('codex', successfulCollect),
    };
    const profiles = createProfileService(config, createEventBus(), adapters);
    const claudeHome = makeCredentialHome(directory, 'claude-home');
    const codexHome = makeCredentialHome(directory, 'codex-home');
    const failedProfile = await profiles.create({
      provider: 'claude',
      label: 'failure',
      home: claudeHome,
    });
    const successfulProfile = await profiles.create({
      provider: 'codex',
      label: 'success',
      home: codexHome,
    });

    const usage = createUsageService(config, createEventBus(), profiles, adapters);
    await usage.refresh();

    expect(failingCollect).toHaveBeenCalledOnce();
    expect(successfulCollect).toHaveBeenCalledOnce();
    expect(usage.latest()[failedProfile.id]).toMatchObject({
      cacheStatus: 'error',
      stale: true,
      windows: [],
      failureKind: 'error',
    });
    expect(usage.latest()[failedProfile.id]?.error).toBe(
      'provider failed with access_token=[redacted]',
    );
    expect(usage.latest()[successfulProfile.id]).toMatchObject({
      source: 'fake live source',
      cacheStatus: 'live',
      windows: [{ id: 'weekly', usedPercent: 25 }],
    });
    expect(fs.statSync(path.join(config.cacheDir, successfulProfile.id)).mode & 0o777).toBe(0o700);

    const fresh = createUsageService(config, createEventBus(), profiles, adapters);
    expect(fresh.latest()).toEqual(usage.latest());
  });

  it('does not refresh disabled or pending profiles during refresh-all', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-usage-filter-test-'));
    temporaryDirectories.push(directory);
    const config = resolveConfig({ dataDir: directory });
    ensureDirs(config);
    const collect = vi.fn(async (): Promise<CollectResult> => cannedResult());
    const adapters: AdapterRegistry = {
      claude: fakeAdapter('claude', collect),
      codex: fakeAdapter('codex', collect),
    };
    const profiles = createProfileService(config, createEventBus(), adapters);
    const active = await profiles.create({
      provider: 'claude',
      label: 'active',
      home: makeCredentialHome(directory, 'active'),
    });
    const disabled = await profiles.create({
      provider: 'codex',
      label: 'disabled',
      home: makeCredentialHome(directory, 'disabled'),
    });
    profiles.update(disabled.id, { enabled: false });
    const pending = await profiles.startWizard('claude');

    const usage = createUsageService(config, createEventBus(), profiles, adapters);
    await usage.refresh();
    expect(collect).toHaveBeenCalledOnce();
    expect(usage.latest()[active.id]).toBeDefined();
    expect(usage.latest()[disabled.id]).toBeUndefined();
    expect(usage.latest()[pending.profile.id]).toBeUndefined();
  });
});

function makeCredentialHome(parent: string, name: string): string {
  const home = path.join(parent, name);
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'credentials'), 'secret test credential');
  return home;
}

function fakeAdapter(
  provider: ProviderId,
  collectUsage: ProviderAdapter['collectUsage'],
): ProviderAdapter {
  return {
    provider,
    displayName: provider,
    capabilities: { usage: true, usageSources: ['local-files'], identity: true, windows: [] },
    hasCredentials: (home) => fs.existsSync(path.join(home, 'credentials')),
    detectIdentity: (): ProviderIdentity => ({ account: null, organization: null, plan: null }),
    collectUsage,
    env: (home) => ({ HOME_FOR_TEST: home }),
    loginCommand: (home) => `login ${home}`,
    defaultHome: () => path.join(os.tmpdir(), `missing-${provider}`),
  };
}

function cannedResult(): CollectResult {
  return {
    windows: [
      {
        id: 'weekly',
        label: '7d',
        usedPercent: 25,
        remainingPercent: 75,
        resetAt: null,
      },
    ],
    source: 'fake live source',
    cacheStatus: 'live',
    dataUpdatedAt: null,
    stale: false,
    staleReason: null,
    failureKind: null,
    error: null,
    planType: 'test',
    retryAfterSeconds: null,
  };
}
