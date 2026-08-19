import type {
  AddTargetRequest,
  ConfirmWizardRequest,
  ExecutionTarget,
  Profile,
  ProviderId,
  ProviderIdentity,
  StartWizardRequest,
  TargetCandidate,
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
 * It also owns execution targets and their target-scoped profile summaries.
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
  /** Machines the hub's tailnet reports; approving one is a separate act. */
  candidates: TargetCandidate[] = [];
  /** Set to make the tailnet scan fail the way a stopped tailscaled does. */
  scanError: string | null = null;
  /** Every approval the UI sent, so a test can read back what it approved. */
  addedTargets: AddTargetRequest[] = [];
  revokedTargets: string[] = [];

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

  // ---- execution targets ---------------------------------------------------

  /** Register a target the way the daemon's registry would report it. */
  seedTarget(
    target: Partial<ExecutionTarget> & Pick<ExecutionTarget, 'id' | 'label'>,
  ): ExecutionTarget {
    const full: ExecutionTarget = {
      kind: target.id === 'local' ? 'local' : 'remote',
      transport: target.id === 'local' ? 'local' : 'fake',
      identity: { hostname: target.id, address: null, fingerprint: null },
      capabilities: ['exec', 'pty', 'signal', 'profiles'],
      approved: true,
      status: 'online',
      ...target,
    };
    this.targets = [...this.targets, full];
    return full;
  }

  /** A machine on the tailnet — display-only until somebody approves it. */
  seedCandidate(
    candidate: Partial<TargetCandidate> & Pick<TargetCandidate, 'hostname'>,
  ): TargetCandidate {
    const dnsName = candidate.dnsName ?? `${candidate.hostname}.tailnet.ts.net`;
    const full: TargetCandidate = {
      dnsName,
      address: dnsName,
      online: true,
      os: 'linux',
      registeredTargetId: null,
      suggestedId: candidate.hostname,
      ...candidate,
    };
    this.candidates = [...this.candidates, full];
    return full;
  }

  async listTargets(): Promise<ExecutionTarget[]> {
    return this.targets.map((target) => ({ ...target }));
  }

  async listCandidates(): Promise<TargetCandidate[]> {
    if (this.scanError) throw new Error(this.scanError);
    return this.candidates.map((candidate) => ({ ...candidate }));
  }

  /**
   * The approval act, as the daemon performs it: the machine is registered and
   * persisted at once, and every candidate for it flips to "already added".
   */
  async addTarget(body: AddTargetRequest): Promise<ExecutionTarget> {
    if (this.targets.some((target) => target.id === body.id)) {
      throw new Error(`A target named "${body.id}" already exists`);
    }
    this.addedTargets.push(body);
    const target = this.seedTarget({
      id: body.id,
      label: body.label,
      transport: 'ssh',
      identity: { hostname: null, address: body.address, fingerprint: null },
      status: 'unknown',
    });
    this.markRegistered(body.address, target.id);
    return target;
  }

  async deleteTarget(targetId: string): Promise<void> {
    const target = this.targets.find((it) => it.id === targetId);
    if (!target) throw new Error(`No target "${targetId}"`);
    this.revokedTargets.push(targetId);
    this.targets = this.targets.filter((it) => it.id !== targetId);
    this.candidates = this.candidates.map((candidate) =>
      candidate.registeredTargetId === targetId
        ? { ...candidate, registeredTargetId: null }
        : candidate,
    );
  }

  private markRegistered(address: string, targetId: string): void {
    this.candidates = this.candidates.map((candidate) =>
      candidate.address === address ? { ...candidate, registeredTargetId: targetId } : candidate,
    );
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
  switch (profile.provider) {
    case 'claude':
      return `CLAUDE_CONFIG_DIR=${profile.home} claude`;
    case 'codex':
      return `CODEX_HOME=${profile.home} codex login`;
    case 'cursor':
      return process.platform === 'win32'
        ? `CURSOR_CONFIG_DIR=${profile.home} AGENT_CLI_CREDENTIAL_STORE=file APPDATA=${profile.home} cursor-agent login`
        : `CURSOR_CONFIG_DIR=${profile.home} AGENT_CLI_CREDENTIAL_STORE=file XDG_CONFIG_HOME=${profile.home} cursor-agent login`;
    default: {
      const _exhaustive: never = profile.provider;
      return _exhaustive;
    }
  }
}
