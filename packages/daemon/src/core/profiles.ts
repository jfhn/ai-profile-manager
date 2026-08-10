import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { adapters as defaultAdapters, type ProviderAdapter } from '@apm/collectors';
import {
  PROVIDER_IDS,
  profileStoreFileSchema,
  type CreateProfileRequest,
  type DefaultProfileIds,
  type Profile,
  type ProviderId,
  type ProviderIdentity,
  type UpdateProfileRequest,
  type WizardStateResponse,
} from '@apm/shared';
import type { DaemonConfig } from '../config.js';
import { ApiFailure, type EventBus, type ProfileService } from '../context.js';
import { profileCacheDirectory } from './profilePaths.js';

export type AdapterRegistry = Readonly<Record<ProviderId, ProviderAdapter>>;

interface ProfileStoreFile {
  version: 2;
  profiles: Profile[];
  defaultProfileIds: DefaultProfileIds;
}

interface LoadedProfileStore extends ProfileStoreFile {
  migrated: boolean;
}

export function createProfileService(
  config: DaemonConfig,
  events: EventBus,
  adapterRegistry: AdapterRegistry = defaultAdapters,
): ProfileService {
  const loaded = loadStore(config.profilesFile);
  let profiles = loaded.profiles;
  let defaultProfileIds = loaded.defaultProfileIds;

  function persist(): void {
    writeStore(config.profilesFile, { version: 2, profiles, defaultProfileIds });
  }

  if (loaded.migrated) persist();

  function adapterFor(provider: ProviderId): ProviderAdapter {
    const adapter = adapterRegistry[provider];
    if (!adapter) {
      throw new ApiFailure(400, 'bad-request', `Unsupported provider: ${provider}`);
    }
    return adapter;
  }

  function findProfile(id: string): Profile {
    const profile = profiles.find((candidate) => candidate.id === id);
    if (!profile) throw new ApiFailure(404, 'not-found', 'Profile not found');
    return profile;
  }

  function assertUniqueLabel(provider: ProviderId, label: string, exceptId?: string): void {
    const normalized = label.toLocaleLowerCase();
    if (
      profiles.some(
        (profile) =>
          profile.id !== exceptId &&
          profile.provider === provider &&
          profile.label.toLocaleLowerCase() === normalized,
      )
    ) {
      throw new ApiFailure(409, 'label-taken', `Label "${label}" is already in use`);
    }
  }

  function uniqueLabel(provider: ProviderId, base: string, separator = '-'): string {
    if (!labelExists(provider, base)) return base;
    let suffix = 2;
    while (labelExists(provider, `${base}${separator}${suffix}`)) suffix += 1;
    return `${base}${separator}${suffix}`;
  }

  function labelExists(provider: ProviderId, label: string): boolean {
    const normalized = label.toLocaleLowerCase();
    return profiles.some(
      (profile) =>
        profile.provider === provider && profile.label.toLocaleLowerCase() === normalized,
    );
  }

  function wizardResponse(profile: Profile): WizardStateResponse {
    const adapter = adapterFor(profile.provider);
    const credentialsFound = safelyHasCredentials(adapter, profile.home);
    const identity = credentialsFound ? safelyDetectIdentity(adapter, profile.home) : null;
    return {
      profile,
      loginCommand: adapter.loginCommand(profile.home),
      credentialsFound,
      identity,
      suggestedLabel: suggestedLabel(profile.provider, identity),
    };
  }

  function isEligible(profile: Profile): boolean {
    return profile.enabled && profile.status === 'active';
  }

  function assignFirstDefault(provider: ProviderId): void {
    if (defaultProfileIds[provider] !== undefined) return;
    const eligible = profiles.filter(
      (profile) => profile.provider === provider && isEligible(profile),
    );
    const only = eligible.length === 1 ? eligible[0] : undefined;
    if (only) defaultProfileIds = { ...defaultProfileIds, [provider]: only.id };
  }

  function clearDefaultFor(profile: Profile): void {
    if (defaultProfileIds[profile.provider] !== profile.id) return;
    const { [profile.provider]: _removed, ...rest } = defaultProfileIds;
    defaultProfileIds = rest;
  }

  function suggestedLabel(provider: ProviderId, identity: ProviderIdentity | null): string {
    const account = identity?.account;
    if (account) {
      const at = account.indexOf('@');
      if (at > 0) return account.slice(0, at);
    }
    let suffix = 1;
    while (labelExists(provider, `${provider}-${suffix}`)) suffix += 1;
    return `${provider}-${suffix}`;
  }

  return {
    list() {
      return [...profiles].sort(
        (left, right) =>
          left.provider.localeCompare(right.provider) || left.label.localeCompare(right.label),
      );
    },

    get(id) {
      return profiles.find((profile) => profile.id === id) ?? null;
    },

    defaults() {
      return { ...defaultProfileIds };
    },

    setDefault(provider, profileId) {
      adapterFor(provider);
      if (profileId === null) {
        const { [provider]: _removed, ...rest } = defaultProfileIds;
        defaultProfileIds = rest;
      } else {
        const profile = findProfile(profileId);
        if (profile.provider !== provider) {
          throw new ApiFailure(
            400,
            'provider-mismatch',
            `Profile ${profileId} does not belong to provider ${provider}`,
          );
        }
        if (!isEligible(profile)) {
          throw new ApiFailure(
            409,
            'profile-unavailable',
            'The default profile must be active and enabled',
          );
        }
        defaultProfileIds = { ...defaultProfileIds, [provider]: profile.id };
      }
      persist();
      events.emit({ type: 'profiles-changed' });
      return { ...defaultProfileIds };
    },

    providers() {
      return Object.values(adapterRegistry)
        .map((adapter) => ({
          id: adapter.provider,
          label: adapter.displayName,
          capabilities: adapter.capabilities,
        }))
        .sort((left, right) => left.id.localeCompare(right.id));
    },

    async create(req: CreateProfileRequest) {
      const label = validLabel(req.label);
      assertUniqueLabel(req.provider, label);
      const home = existingDirectory(req.home);
      if (
        profiles.some(
          (profile) => profile.provider === req.provider && samePath(profile.home, home),
        )
      ) {
        throw new ApiFailure(409, 'home-taken', 'This provider home is already in use');
      }

      const adapter = adapterFor(req.provider);
      const hasCredentials = safelyHasCredentials(adapter, home);
      const profile: Profile = {
        id: crypto.randomUUID(),
        provider: req.provider,
        label,
        home,
        homeKind: isChildPath(config.homesDir, home) ? 'managed' : 'external',
        identity: safelyDetectIdentity(adapter, home),
        status: hasCredentials ? 'active' : 'error',
        statusReason: hasCredentials ? null : 'no credentials found',
        enabled: true,
        createdAt: new Date().toISOString(),
      };
      profiles = [...profiles, profile];
      assignFirstDefault(profile.provider);
      persist();
      events.emit({ type: 'profiles-changed' });
      return profile;
    },

    update(id: string, req: UpdateProfileRequest) {
      const current = findProfile(id);
      const label = req.label === undefined ? undefined : validLabel(req.label);
      if (label !== undefined) assertUniqueLabel(current.provider, label, id);
      const updated: Profile = {
        ...current,
        ...(label !== undefined ? { label } : {}),
        ...(req.enabled !== undefined ? { enabled: req.enabled } : {}),
      };
      profiles = profiles.map((profile) => (profile.id === id ? updated : profile));
      if (!isEligible(updated)) clearDefaultFor(updated);
      persist();
      events.emit({ type: 'profiles-changed' });
      return updated;
    },

    async remove(id: string, purge: boolean) {
      const profile = findProfile(id);
      if (purge && profile.homeKind !== 'managed') {
        throw new ApiFailure(400, 'external-home', 'External profile homes cannot be purged');
      }
      if (purge) {
        if (!isChildPath(config.homesDir, profile.home)) {
          throw new ApiFailure(
            400,
            'unsafe-home',
            'Managed profile home is outside the homes directory',
          );
        }
        fs.rmSync(profile.home, { recursive: true, force: true });
      }
      fs.rmSync(profileCacheDirectory(config.cacheDir, profile.id), {
        recursive: true,
        force: true,
      });
      profiles = profiles.filter((candidate) => candidate.id !== id);
      clearDefaultFor(profile);
      persist();
      events.emit({ type: 'profiles-changed' });
    },

    async discovery() {
      const candidates = [];
      for (const adapter of Object.values(adapterRegistry)) {
        let home: string;
        try {
          home = existingDirectory(adapter.defaultHome());
        } catch {
          continue;
        }
        if (
          profiles.some(
            (profile) => profile.provider === adapter.provider && samePath(profile.home, home),
          )
        ) {
          continue;
        }
        const hasCredentials = safelyHasCredentials(adapter, home);
        candidates.push({
          provider: adapter.provider,
          home,
          isDefault: true,
          hasCredentials,
          identity: safelyDetectIdentity(adapter, home),
        });
      }
      return candidates;
    },

    async startWizard(provider: ProviderId) {
      const adapter = adapterFor(provider);
      const id = crypto.randomUUID();
      const home = path.join(config.homesDir, id);
      fs.mkdirSync(config.homesDir, { recursive: true, mode: 0o700 });
      fs.mkdirSync(home, { recursive: false, mode: 0o700 });
      const profile: Profile = {
        id,
        provider,
        label: uniqueLabel(provider, `new-${provider}`),
        home,
        homeKind: 'managed',
        identity: null,
        status: 'pending',
        statusReason: null,
        enabled: true,
        createdAt: new Date().toISOString(),
      };
      profiles = [...profiles, profile];
      try {
        persist();
      } catch (error) {
        profiles = profiles.filter((candidate) => candidate.id !== id);
        fs.rmSync(home, { recursive: true, force: true });
        throw error;
      }
      events.emit({ type: 'profiles-changed' });
      return {
        profile,
        loginCommand: adapter.loginCommand(home),
        credentialsFound: false,
        identity: null,
        suggestedLabel: '',
      };
    },

    async wizardState(profileId: string) {
      const profile = findProfile(profileId);
      if (profile.status !== 'pending') {
        throw new ApiFailure(409, 'not-pending', 'Profile is not pending login');
      }
      return wizardResponse(profile);
    },

    async confirmWizard(profileId: string, requestedLabel: string) {
      const profile = findProfile(profileId);
      if (profile.status !== 'pending') {
        throw new ApiFailure(409, 'not-pending', 'Profile is not pending login');
      }
      const adapter = adapterFor(profile.provider);
      if (!safelyHasCredentials(adapter, profile.home)) {
        throw new ApiFailure(409, 'no-credentials', 'No credentials found');
      }
      const label = validLabel(requestedLabel);
      assertUniqueLabel(profile.provider, label, profile.id);
      const updated: Profile = {
        ...profile,
        label,
        identity: safelyDetectIdentity(adapter, profile.home),
        status: 'active',
        statusReason: null,
      };
      profiles = profiles.map((candidate) => (candidate.id === profileId ? updated : candidate));
      assignFirstDefault(updated.provider);
      persist();
      events.emit({ type: 'profiles-changed' });
      return updated;
    },

    envFor(profileId: string) {
      const profile = findProfile(profileId);
      return adapterFor(profile.provider).env(profile.home);
    },
  };
}

function loadStore(file: string): LoadedProfileStore {
  if (!fs.existsSync(file)) {
    return { version: 2, profiles: [], defaultProfileIds: {}, migrated: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid profile store at ${file}: ${message}`);
  }
  const normalized = normalizePersistedHomes(parsed);
  parsed = normalized.value;
  const result = profileStoreFileSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => issue.message).join('; ');
    throw new Error(`Invalid profile store at ${file}: ${issues}`);
  }
  validatePersistedProfileUniqueness(file, result.data.profiles);
  if (result.data.version === 1) {
    return {
      version: 2,
      profiles: result.data.profiles,
      defaultProfileIds: inferMigratedDefaults(result.data.profiles),
      migrated: true,
    };
  }
  validatePersistedDefaults(file, result.data.profiles, result.data.defaultProfileIds);
  return {
    version: 2,
    profiles: result.data.profiles,
    defaultProfileIds: result.data.defaultProfileIds,
    migrated: normalized.changed,
  };
}

function validatePersistedProfileUniqueness(file: string, profiles: Profile[]): void {
  for (const [index, profile] of profiles.entries()) {
    for (let earlierIndex = 0; earlierIndex < index; earlierIndex += 1) {
      const earlier = profiles[earlierIndex];
      if (earlier === undefined || earlier.provider !== profile.provider) continue;
      if (earlier.label.toLocaleLowerCase() === profile.label.toLocaleLowerCase()) {
        throw new Error(
          `Invalid profile store at ${file}: profiles[${index}].label duplicates profiles[${earlierIndex}].label for provider ${profile.provider}`,
        );
      }
      if (samePath(earlier.home, profile.home)) {
        throw new Error(
          `Invalid profile store at ${file}: profiles[${index}].home duplicates profiles[${earlierIndex}].home for provider ${profile.provider}`,
        );
      }
    }
  }
}

/**
 * Older releases could persist relative homes when APM_DATA_DIR was relative.
 * Resolve those with the same cwd semantics the old daemon used, but do not
 * canonicalize absolute/external homes or touch disk until the entire store
 * has passed validation.
 */
function normalizePersistedHomes(value: unknown): { value: unknown; changed: boolean } {
  if (!isRecord(value) || !Array.isArray(value.profiles)) return { value, changed: false };
  let changed = false;
  const profiles = value.profiles.map((candidate) => {
    if (
      !isRecord(candidate) ||
      typeof candidate.home !== 'string' ||
      candidate.home.trim().length === 0 ||
      path.isAbsolute(candidate.home)
    ) {
      return candidate;
    }
    changed = true;
    return { ...candidate, home: path.resolve(candidate.home) };
  });
  return { value: changed ? { ...value, profiles } : value, changed };
}

function inferMigratedDefaults(profiles: Profile[]): DefaultProfileIds {
  const defaults: DefaultProfileIds = {};
  for (const provider of PROVIDER_IDS) {
    const eligible = profiles.filter(
      (profile) => profile.provider === provider && profile.enabled && profile.status === 'active',
    );
    const only = eligible.length === 1 ? eligible[0] : undefined;
    if (only) defaults[provider] = only.id;
  }
  return defaults;
}

function validatePersistedDefaults(
  file: string,
  profiles: Profile[],
  defaults: DefaultProfileIds,
): void {
  for (const provider of PROVIDER_IDS) {
    const profileId = defaults[provider];
    if (profileId === undefined) continue;
    const profile = profiles.find((candidate) => candidate.id === profileId);
    if (
      !profile ||
      profile.provider !== provider ||
      !profile.enabled ||
      profile.status !== 'active'
    ) {
      throw new Error(
        `Invalid profile store at ${file}: default for ${provider} must reference an active, enabled ${provider} profile`,
      );
    }
  }
}

function writeStore(file: string, store: ProfileStoreFile): void {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The temporary file may not have been created.
    }
    throw error;
  }
}

function existingDirectory(input: string): string {
  const resolved = path.resolve(input);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new ApiFailure(400, 'invalid-home', 'Profile home must be an existing directory');
  }
  if (!stat.isDirectory()) {
    throw new ApiFailure(400, 'invalid-home', 'Profile home must be an existing directory');
  }
  return fs.realpathSync(resolved);
}

function samePath(left: string, right: string): boolean {
  return canonicalPath(left) === canonicalPath(right);
}

function canonicalPath(value: string): string {
  try {
    return fs.realpathSync(path.resolve(value));
  } catch {
    return path.resolve(value);
  }
}

function isChildPath(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function validLabel(input: string): string {
  const label = input.trim();
  if (label.length === 0 || label.length > 64) {
    throw new ApiFailure(400, 'bad-request', 'Label must contain between 1 and 64 characters');
  }
  return label;
}

function safelyHasCredentials(adapter: ProviderAdapter, home: string): boolean {
  try {
    return adapter.hasCredentials(home);
  } catch {
    return false;
  }
}

function safelyDetectIdentity(adapter: ProviderAdapter, home: string): ProviderIdentity | null {
  try {
    return adapter.detectIdentity(home);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
