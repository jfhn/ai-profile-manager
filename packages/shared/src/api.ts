import type { Profile } from './profile.js';
import type { AdapterCapabilities, ProviderId, ProviderIdentity } from './provider.js';
import type { UsageSnapshot } from './usage.js';
import type { TerminalSession } from './sessions.js';
import type { TargetProfileSummary } from './target.js';
import type { T3Instance } from './t3.js';

/**
 * REST API contract (see docs/API.md for the full prose spec).
 * All endpoints live under /api, require `Authorization: Bearer <token>`
 * (or ?token= for SSE/WS), and return ApiError on failure.
 */

export interface ApiError {
  error: {
    code: string;
    message: string;
  };
}

export interface StatusResponse {
  name: 'apm';
  version: string;
  pid: number;
  startedAt: string;
  dataDir: string;
}

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  capabilities: AdapterCapabilities;
}

/** GET /api/overview — everything the dashboard needs in one round trip. */
export interface OverviewResponse {
  providers: ProviderInfo[];
  profiles: Profile[];
  /** Latest snapshot per profile id; absent when never collected. */
  usage: Record<string, UsageSnapshot>;
  sessions: TerminalSession[];
  t3Instances: T3Instance[];
}

/** GET /api/discovery — existing provider homes not yet adopted as profiles. */
export interface DiscoveryCandidate {
  provider: ProviderId;
  home: string;
  /** True for the global default home (~/.claude, ~/.codex). */
  isDefault: boolean;
  hasCredentials: boolean;
  identity: ProviderIdentity | null;
}
export interface DiscoveryResponse {
  candidates: DiscoveryCandidate[];
}

/** POST /api/profiles — adopt an existing home (from discovery or manual path). */
export interface CreateProfileRequest {
  provider: ProviderId;
  label: string;
  home: string;
}

/** PATCH /api/profiles/:id */
export interface UpdateProfileRequest {
  label?: string;
  enabled?: boolean;
}

/**
 * Wizard (prepare-login) flow — the app never performs logins itself:
 * 1. POST /api/wizard        -> pending profile + fresh managed home + login command
 * 2. GET  /api/wizard/:id    -> poll: credentials found? detected identity?
 * 3. POST /api/wizard/:id/confirm {label} -> activate
 * 4. DELETE /api/profiles/:id?purge=true  -> abandon (managed homes only)
 */
export interface StartWizardRequest {
  provider: ProviderId;
}
export interface WizardStateResponse {
  profile: Profile;
  /** Exact command to run in a normal terminal. */
  loginCommand: string;
  credentialsFound: boolean;
  identity: ProviderIdentity | null;
  /** Prefilled suggestion for the profile label. */
  suggestedLabel: string;
}
export interface ConfirmWizardRequest {
  label: string;
}

/** GET /api/sessions */
export interface SessionsResponse {
  sessions: TerminalSession[];
}

/** GET /api/t3 */
export interface T3ListResponse {
  instances: T3Instance[];
}

/** POST /api/sessions */
export interface CreateSessionRequest {
  /** Omitted means the daemon's local target. */
  targetId?: string;
  profileId: string;
  app: string;
  args?: string[];
  cwd?: string;
  cols?: number;
  rows?: number;
}

/** GET /api/targets/:targetId/profiles */
export interface TargetProfilesResponse {
  profiles: TargetProfileSummary[];
}

/** GET /api/recent-dirs — recently used working directories for the picker. */
export interface RecentDirsResponse {
  dirs: string[];
}

/** POST /api/t3 */
export interface CreateT3InstanceRequest {
  label: string;
  profiles: Partial<Record<ProviderId, string>>;
}

/**
 * SSE stream: GET /api/events?token=...
 * Each event: `event: <type>` + `data: <json>`.
 */
export type ServerEvent =
  | { type: 'profiles-changed' }
  | { type: 'usage-updated'; profileId: string; snapshot: UsageSnapshot }
  | { type: 'sessions-changed'; sessions: TerminalSession[] }
  | { type: 't3-changed'; instances: T3Instance[] };
