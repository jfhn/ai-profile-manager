import type {
  ConfirmWizardRequest,
  CreateT3InstanceRequest,
  EndpointScope,
  ExecutionTarget,
  Profile,
  ProviderId,
  ProviderIdentity,
  StartWizardRequest,
  T3Instance,
  TargetProfileSummary,
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
 *
 * It also owns the execution targets and their T3 instances, because both are
 * target-scoped: a target reports its own profiles, and an instance's Open link
 * comes from that target's endpoint rather than from anything the UI builds.
 */
export class FakeDaemon implements WizardApi {
  profiles: Profile[] = [];
  /** Flipped when the user finishes the provider login in their own terminal. */
  credentialsFound = false;
  account = 'tester@example.com';
  deleted: Array<{ id: string; purge: boolean }> = [];
  /** Every profile id `wizardState` was asked about, in order. */
  wizardStateCalls: string[] = [];

  targets: ExecutionTarget[] = [];
  /** Profiles per target id — a profile id on one target means nothing on another. */
  targetProfileLists: Record<string, TargetProfileSummary[]> = {};
  t3Instances: T3Instance[] = [];
  /** Every create request the UI sent, so a test can read the target back. */
  createdT3: CreateT3InstanceRequest[] = [];

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

  // ---- execution targets and T3 instances ----------------------------------

  /** Register a target the way the daemon's registry would report it. */
  seedTarget(
    target: Partial<ExecutionTarget> & Pick<ExecutionTarget, 'id' | 'label'>,
  ): ExecutionTarget {
    const full: ExecutionTarget = {
      kind: target.id === 'local' ? 'local' : 'remote',
      transport: target.id === 'local' ? 'local' : 'fake',
      identity: { hostname: target.id, address: null, fingerprint: null },
      capabilities: ['exec', 'pty', 'signal', 'endpoint', 'profiles'],
      approved: true,
      status: 'online',
      ...target,
    };
    this.targets = [...this.targets, full];
    return full;
  }

  /** A stopped instance on a target, ready for the card or the list. */
  seedT3Instance(instance: Partial<T3Instance> & Pick<T3Instance, 'label'>): T3Instance {
    const full: T3Instance = {
      id: crypto.randomUUID(),
      targetId: 'local',
      port: null,
      baseDir: '/home/tester/.local/share/apm/t3/instance',
      profiles: {},
      status: 'stopped',
      pid: null,
      url: null,
      endpoint: null,
      statusReason: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      ...instance,
    };
    this.t3Instances = [...this.t3Instances, full];
    return full;
  }

  /** Mark a seeded instance running on the endpoint its target would report. */
  runT3Instance(
    instance: T3Instance,
    endpoint: { scope: EndpointScope; port: number; url: string },
  ): T3Instance {
    const running: T3Instance = {
      ...instance,
      status: 'running',
      port: endpoint.port,
      url: endpoint.url,
      endpoint: { scope: endpoint.scope, protocol: 'http', port: endpoint.port, url: endpoint.url },
    };
    this.t3Instances = this.t3Instances.map((it) => (it.id === running.id ? running : it));
    return running;
  }

  async listTargets(): Promise<ExecutionTarget[]> {
    return this.targets.map((target) => ({ ...target }));
  }

  async targetProfiles(targetId: string): Promise<TargetProfileSummary[]> {
    const profiles = this.targetProfileLists[targetId];
    if (!profiles) throw new Error(`No target "${targetId}"`);
    return profiles.map((profile) => ({ ...profile }));
  }

  async createT3(body: CreateT3InstanceRequest): Promise<T3Instance> {
    this.createdT3.push(body);
    return this.seedT3Instance({
      label: body.label,
      targetId: body.targetId ?? 'local',
      profiles: body.profiles,
    });
  }

  /**
   * The daemon answers start/stop with the whole instance, and the URL it
   * carries always comes from the target's endpoint — never from the client.
   */
  async startT3(instanceId: string): Promise<T3Instance> {
    return this.findInstance(instanceId);
  }

  async stopT3(instanceId: string): Promise<T3Instance> {
    const stopped: T3Instance = {
      ...this.findInstance(instanceId),
      status: 'stopped',
      port: null,
      url: null,
      endpoint: null,
    };
    this.t3Instances = this.t3Instances.map((it) => (it.id === stopped.id ? stopped : it));
    return stopped;
  }

  async deleteT3(instanceId: string): Promise<void> {
    this.t3Instances = this.t3Instances.filter((it) => it.id !== instanceId);
  }

  private findInstance(instanceId: string): T3Instance {
    const instance = this.t3Instances.find((it) => it.id === instanceId);
    if (!instance) throw new Error(`Unknown T3 instance ${instanceId}`);
    return instance;
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
   * Unpredictable on purpose, exactly as the daemon's `crypto.randomUUID()` is.
   * A test must not be able to pass by hard-coding an id, because that would
   * hide a card wiring the wrong profile into the wizard. Nothing asserts a
   * literal id — every reference goes through a returned `Profile` — so this
   * costs no determinism.
   */
  private nextId(): string {
    return crypto.randomUUID();
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
