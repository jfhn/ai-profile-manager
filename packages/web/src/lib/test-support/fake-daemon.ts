import type {
  ConfirmWizardRequest,
  Profile,
  ProviderId,
  ProviderIdentity,
  StartWizardRequest,
  WizardStateResponse,
} from '@apm/shared';
import type { WizardApi } from '../wizard.svelte';

/**
 * An in-memory stand-in for the daemon's profile store and wizard endpoints.
 *
 * It owns the profile list, so a wizard built from nothing but a profile id
 * behaves exactly like the dashboard does after a page reload. The responses
 * mirror `packages/daemon/src/core/profiles.ts` and the provider adapters
 * closely — in particular the login commands and the suggested-label rules,
 * both of which the UI makes decisions on.
 */
export class FakeDaemon implements WizardApi {
  profiles: Profile[] = [];
  /** Flipped when the user finishes the provider login in their own terminal. */
  credentialsFound = false;
  account = 'tester@example.com';
  deleted: Array<{ id: string; purge: boolean }> = [];
  /** Every profile id `wizardState` was asked about, in order. */
  wizardStateCalls: string[] = [];
  private counter = 0;

  /** Seed a profile that is already pending, as if an earlier wizard made it. */
  seedPending(provider: ProviderId): Profile {
    const id = this.nextId();
    const profile: Profile = {
      id,
      provider,
      // The daemon gives a pending profile a placeholder name up front, so the
      // dashboard has something to render before the login finishes.
      label: this.uniqueLabel(provider, `new-${provider}`),
      home: `/home/tester/.local/share/apm/homes/${provider}/${id}`,
      homeKind: 'managed',
      identity: null,
      status: 'pending',
      statusReason: null,
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    this.profiles = [...this.profiles, profile];
    return profile;
  }

  /**
   * Mirrors `startWizard`, which hardcodes an empty suggestion because the
   * fresh home cannot have an identity yet.
   */
  async startWizard({ provider }: StartWizardRequest): Promise<WizardStateResponse> {
    const profile = this.seedPending(provider);
    return {
      profile,
      loginCommand: loginCommand(profile),
      credentialsFound: false,
      identity: null,
      suggestedLabel: '',
    };
  }

  async wizardState(profileId: string): Promise<WizardStateResponse> {
    this.wizardStateCalls.push(profileId);
    const profile = this.find(profileId);
    if (profile.status !== 'pending') throw new Error('Profile is not pending login');
    const identity = this.identity();
    return {
      profile,
      loginCommand: loginCommand(profile),
      credentialsFound: this.credentialsFound,
      identity,
      // Unlike startWizard this always answers with *some* name.
      suggestedLabel: this.suggestedLabel(profile.provider, identity),
    };
  }

  async confirmWizard(profileId: string, { label }: ConfirmWizardRequest): Promise<Profile> {
    const profile = this.find(profileId);
    if (profile.status !== 'pending') throw new Error('Profile is not pending login');
    if (!this.credentialsFound) throw new Error('No credentials found');
    if (!label.trim()) throw new Error('Label must not be empty');
    if (this.labelExists(profile.provider, label, profile.id)) {
      throw new Error(`A ${profile.provider} profile named ${label} already exists`);
    }
    const updated: Profile = {
      ...profile,
      label,
      identity: this.identity(),
      status: 'active',
      statusReason: null,
    };
    this.profiles = this.profiles.map((it) => (it.id === profileId ? updated : it));
    return updated;
  }

  async deleteProfile(profileId: string, purge = false): Promise<void> {
    this.deleted.push({ id: profileId, purge });
    this.profiles = this.profiles.filter((it) => it.id !== profileId);
  }

  profile(profileId: string): Profile | undefined {
    return this.profiles.find((it) => it.id === profileId);
  }

  private identity(): ProviderIdentity | null {
    return this.credentialsFound
      ? { account: this.account, organization: null, plan: 'max' }
      : null;
  }

  /** The daemon's rule: local-part of the account, else a positional fallback. */
  private suggestedLabel(provider: ProviderId, identity: ProviderIdentity | null): string {
    const account = identity?.account;
    if (account) {
      const at = account.indexOf('@');
      if (at > 0) return account.slice(0, at);
    }
    let suffix = 1;
    while (this.labelExists(provider, `${provider}-${suffix}`)) suffix += 1;
    return `${provider}-${suffix}`;
  }

  /**
   * Reproducible across runs, but deliberately not positional. The daemon uses
   * `crypto.randomUUID()`, so a test must not be able to pass by hard-coding
   * the id of the first seeded profile — that would hide a card wiring the
   * wrong profile into the wizard.
   */
  private nextId(): string {
    let hash = (++this.counter * 0x9e3779b1) >>> 0 || 1;
    const word = (): string => {
      hash = (hash ^ (hash << 13)) >>> 0;
      hash = (hash ^ (hash >>> 17)) >>> 0;
      hash = (hash ^ (hash << 5)) >>> 0;
      return hash.toString(16).padStart(8, '0');
    };
    const short = (): string => word().slice(0, 4);
    return `${word()}-${short()}-${short()}-${short()}-${word()}${short()}`;
  }

  private uniqueLabel(provider: ProviderId, base: string): string {
    if (!this.labelExists(provider, base)) return base;
    let suffix = 2;
    while (this.labelExists(provider, `${base}-${suffix}`)) suffix += 1;
    return `${base}-${suffix}`;
  }

  private labelExists(provider: ProviderId, label: string, exceptId?: string): boolean {
    const normalized = label.toLocaleLowerCase();
    return this.profiles.some(
      (it) =>
        it.provider === provider &&
        it.label.toLocaleLowerCase() === normalized &&
        it.id !== exceptId,
    );
  }

  private find(profileId: string): Profile {
    const profile = this.profile(profileId);
    if (!profile) throw new Error(`Unknown profile ${profileId}`);
    return profile;
  }
}

/** Copies of the real adapters' commands (collectors/src/adapters/*.ts). */
export function loginCommand(profile: Pick<Profile, 'provider' | 'home'>): string {
  return profile.provider === 'claude'
    ? `CLAUDE_CONFIG_DIR=${profile.home} claude`
    : `CODEX_HOME=${profile.home} codex login`;
}
