import type {
  CreateProfileRequest,
  CreateSessionRequest,
  CreateT3InstanceRequest,
  DiscoveryCandidate,
  Profile,
  ProviderId,
  ProviderInfo,
  ServerEvent,
  T3Instance,
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
 *   - src/t3/       managed T3 instances
 * Routes only ever talk to these interfaces.
 */

export interface EventBus {
  emit(event: ServerEvent): void;
  subscribe(listener: (event: ServerEvent) => void): () => void;
}

export interface ProfileService {
  list(): Profile[];
  get(id: string): Profile | null;
  providers(): ProviderInfo[];
  create(req: CreateProfileRequest): Promise<Profile>;
  update(id: string, req: UpdateProfileRequest): Profile;
  /** purge additionally deletes the home dir — allowed for managed homes only. */
  remove(id: string, purge: boolean): Promise<void>;
  discovery(): Promise<DiscoveryCandidate[]>;
  startWizard(provider: ProviderId): Promise<WizardStateResponse>;
  wizardState(profileId: string): Promise<WizardStateResponse>;
  confirmWizard(profileId: string, label: string): Promise<Profile>;
  /** Env vars binding a spawned process tree to this profile (CLAUDE_CONFIG_DIR / CODEX_HOME). */
  envFor(profileId: string): Record<string, string>;
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

export interface SessionHost {
  list(): TerminalSession[];
  create(req: CreateSessionRequest): Promise<TerminalSession>;
  kill(id: string): void;
  /** Remove an exited session from the list. */
  dispose(id: string): void;
  resize(id: string, cols: number, rows: number): void;
  /** Kill all PTYs on daemon shutdown. */
  shutdown(): void;
  recentDirs(): string[];
}

export interface T3Manager {
  list(): T3Instance[];
  create(req: CreateT3InstanceRequest): Promise<T3Instance>;
  start(id: string): Promise<T3Instance>;
  stop(id: string): Promise<T3Instance>;
  remove(id: string): Promise<void>;
  /** Re-adopt detached instances still running from a previous daemon. */
  adopt(): Promise<void>;
  /**
   * Local instances are detached on purpose and keep running. Remote ones are
   * terminated and their endpoints revoked: nothing on a target may outlive
   * the daemon that was supervising it.
   */
  shutdown(): Promise<void>;
}

export interface AppContext {
  config: DaemonConfig;
  events: EventBus;
  profiles: ProfileService;
  usage: UsageService;
  sessions: SessionHost;
  t3: T3Manager;
  /** Execution targets and their transports; the local one is the default. */
  targets: TargetRegistry;
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
