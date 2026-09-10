import type {
  CreateProfileRequest,
  CreateSessionRequest,
  DefaultProfileIds,
  DiscoveryCandidate,
  Profile,
  ProfileCopyResponse,
  ProfileEnv,
  ProfileSync,
  ProviderId,
  ProviderInfo,
  CliToolStatus,
  UpdateCliToolResponse,
  ServerEvent,
  TerminalSession,
  UpdateProfileRequest,
  UsageSnapshot,
  WizardStateResponse,
} from '@apm/shared';
import type { DaemonConfig } from './config.js';
import type { TargetRegistry } from './targets/registry.js';

/**
 * Service seams between daemon modules. Implementations live in:
 *   - src/core/     profiles, discovery, wizard, usage scheduling, events
 *   - src/sessions/ PTY session host + terminal WebSocket
 * Routes only ever talk to these interfaces.
 */

export interface EventBus {
  emit(event: ServerEvent): void;
  subscribe(listener: (event: ServerEvent) => void): () => void;
}

export interface ProfileService {
  /**
   * Re-read the detected identity of every active profile. Touches disk per
   * profile, so the daemon runs it once after it is already serving.
   */
  refreshIdentities(): void;
  list(): Profile[];
  get(id: string): Profile | null;
  defaults(): DefaultProfileIds;
  setDefault(provider: ProviderId, profileId: string | null): DefaultProfileIds;
  providers(): ProviderInfo[];
  create(req: CreateProfileRequest): Promise<Profile>;
  update(id: string, req: UpdateProfileRequest): Profile;
  /** purge additionally deletes the home dir — allowed for managed homes only. */
  remove(id: string, purge: boolean): Promise<void>;
  discovery(): Promise<DiscoveryCandidate[]>;
  startWizard(provider: ProviderId): Promise<WizardStateResponse>;
  wizardState(profileId: string): Promise<WizardStateResponse>;
  confirmWizard(profileId: string, label: string): Promise<Profile>;
  /** Env binding a spawned process to this profile (CLAUDE_CONFIG_DIR / CODEX_HOME / ...). */
  envFor(profileId: string): ProfileEnv;
  /** Make this profile a sync owner (assigns a sync id). Idempotent. */
  enableSync(id: string): Profile;
  /**
   * Create a replica profile for an adopted remote credential set. The only
   * way a replica comes to exist — create()/update() cannot set `sync`.
   */
  createReplica(req: {
    provider: ProviderId;
    label: string;
    home: string;
    sync: ProfileSync;
  }): Promise<Profile>;
}

/** Options for a single usage refresh run. */
export interface RefreshOptions {
  /**
   * Set for user-initiated refreshes: adapters then skip their error
   * cooldowns and attempt a real fetch. The periodic scheduler and the
   * start-up refresh leave it unset so cooldowns keep throttling them.
   */
  force?: boolean;
}

export interface UsageService {
  /** Latest snapshot per profile id. */
  latest(): Record<string, UsageSnapshot>;
  /** Refresh one profile (or all enabled) now; per-profile failures are isolated. */
  refresh(profileId?: string, options?: RefreshOptions): Promise<void>;
  /** Start/stop the periodic scheduler. */
  start(): void;
  stop(): void;
}

export interface CliToolService {
  list(): Promise<CliToolStatus[]>;
  update(provider: ProviderId): Promise<UpdateCliToolResponse>;
}

export interface SessionHost {
  list(): TerminalSession[];
  create(req: CreateSessionRequest): Promise<TerminalSession>;
  kill(id: string): void;
  /** Remove an exited session from the list. */
  dispose(id: string): void;
  resize(id: string, cols: number, rows: number): void;
  /** Kill all PTYs on daemon shutdown. */
  shutdown(): Promise<void>;
  recentDirs(): string[];
}

/** Credential sync scheduler: push-on-rotate, pull-on-auth-failure. */
export interface SyncService {
  start(): void;
  stop(): void;
  /** One push sweep over all synced profiles; start() runs this periodically. */
  tick(): Promise<void>;
  /** Enroll a local profile on exactly the selected approved remote targets. */
  copyProfile(profileId: string, targetIds: string[]): Promise<ProfileCopyResponse>;
}

export interface AppContext {
  config: DaemonConfig;
  events: EventBus;
  profiles: ProfileService;
  usage: UsageService;
  tools: CliToolService;
  sessions: SessionHost;
  /** Execution targets and their transports; the local one is the default. */
  targets: TargetRegistry;
  /** Credential sync between this machine and approved targets. */
  sync: SyncService;
}

/** Error with an HTTP status + stable code; routes map it to ApiError. */
export class ApiFailure extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
