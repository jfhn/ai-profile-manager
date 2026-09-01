import type { DefaultProfileIds, Profile, ProfileStatus } from './profile.js';
import type { AdapterCapabilities, ProviderId, ProviderIdentity } from './provider.js';
import type { UsageSnapshot } from './usage.js';
import type { TerminalSession } from './sessions.js';
import type { ExecutionTarget, TargetCandidate, TargetId, TargetProfileSummary } from './target.js';
import type { CredentialBundle } from './transport.js';

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
  /** argv[0] for a normal session of this provider (`claude`, `codex`, `cursor-agent`). */
  defaultApp: string;
}

export interface CliToolBase {
  provider: ProviderId;
  label: string;
}

export interface InstalledCliTool extends CliToolBase {
  state: 'installed';
  executable: string;
  version: string;
}

export type CliToolStatus =
  | InstalledCliTool
  | (CliToolBase & { state: 'missing' })
  | (CliToolBase & { state: 'error'; executable: string; error: string });

export interface CliToolsResponse {
  tools: CliToolStatus[];
}

export interface UpdateCliToolResponse {
  previousVersion: string;
  tool: InstalledCliTool;
}

/** GET /api/overview — everything the dashboard needs in one round trip. */
export interface OverviewResponse {
  providers: ProviderInfo[];
  profiles: Profile[];
  defaultProfileIds: DefaultProfileIds;
  /** Latest snapshot per profile id; absent when never collected. */
  usage: Record<string, UsageSnapshot>;
  sessions: TerminalSession[];
}

/** GET /api/defaults and PUT /api/defaults/:provider. */
export interface DefaultsResponse {
  defaultProfileIds: DefaultProfileIds;
}

export interface UpdateDefaultProfileRequest {
  /** null explicitly clears the provider default. */
  profileId: string | null;
}

/** Stable stdout contract returned by `apm profiles --json`. */
export interface ProfilesCliResponse {
  schemaVersion: 2;
  defaultProfileIds: DefaultProfileIds;
  profiles: Array<{
    id: string;
    provider: ProviderId;
    label: string;
    home: string;
    status: ProfileStatus;
    enabled: boolean;
    usage: UsageSnapshot | null;
  }>;
}

/** Stable stdout contract returned by `apm targets --json`. */
export interface TargetCliSummary extends Omit<ExecutionTarget, 'capabilities'> {
  /** Capability names are open-ended so version-1 consumers can ignore
   * features they do not understand without rejecting the target. */
  capabilities: string[];
}

export interface TargetsCliResponse {
  schemaVersion: 1;
  targets: TargetCliSummary[];
}

/** Stable stdout contract returned by `apm targets --profiles <target> --json`. */
export interface TargetProfilesCliResponse {
  schemaVersion: 2;
  targetId: TargetId;
  profiles: TargetProfileSummary[];
}

/** GET /api/discovery — existing provider homes not yet adopted as profiles. */
export interface DiscoveryCandidate {
  provider: ProviderId;
  home: string;
  /** True for the global default home (~/.claude, ~/.codex, ~/.cursor). */
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

/** POST /api/targets/:id/sync-adopt — create a replica of a remote profile. */
export interface SyncAdoptRequest {
  provider: ProviderId;
  remoteProfileId: string;
  /** Defaults to the remote profile's label, de-duplicated locally. */
  label?: string;
}

/** POST /api/profiles/:id/copy — enroll this profile on selected targets. */
export interface ProfileCopyRequest {
  targetIds: TargetId[];
}

export type ProfileCopyTargetResult =
  | { targetId: TargetId; status: 'copied'; profile: TargetProfileSummary }
  | { targetId: TargetId; status: 'failed'; errorCode: string };

export interface ProfileCopyResponse {
  /** The local profile after sync has been enabled (owner or existing replica). */
  profile: Profile;
  results: ProfileCopyTargetResult[];
}

/**
 * Internal loopback API used by the SSH target agent. The response is a
 * normal Profile, but this request's credential bundle must never be logged.
 */
export interface SyncEnrollRequest {
  syncId: string;
  provider: ProviderId;
  label: string;
  bundle: CredentialBundle;
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

/** POST /api/sessions */
export interface CreateSessionRequest {
  /** Omitted means the daemon's local target. */
  targetId?: string;
  profileId: string;
  app: string;
  args?: string[];
  cwd?: string;
  /**
   * Persistent sessions survive client disconnects and may be reattached.
   * Connection-bound sessions are killed after their last attached client
   * disconnects; this is intended for process-owning integrations.
   */
  lifecycle?: 'persistent' | 'connection-bound';
  cols?: number;
  rows?: number;
}

/** GET /api/recent-dirs — recently used working directories for the picker. */
export interface RecentDirsResponse {
  dirs: string[];
}

/** GET /api/targets — read-only view of the registry, for the target picker. */
export interface TargetsResponse {
  targets: ExecutionTarget[];
}

/**
 * GET /api/targets/candidates — machines on the hub's tailnet, display-only.
 * Seeing a machine here grants nothing: it becomes a target only through an
 * explicit POST /api/targets for that one machine.
 */
export interface TargetCandidatesResponse {
  candidates: TargetCandidate[];
}

/**
 * POST /api/targets — approve one machine as a target and register it now.
 * The address is a tailnet name that came from a candidate, never a free-form
 * host somebody typed; approval is written as `approved: true` in targets.json.
 */
export interface AddTargetRequest {
  id: TargetId;
  label: string;
  address: string;
}

/**
 * GET /api/targets/:id/profiles — profiles as that target reports them.
 * Profile ids are target-scoped, so the picker must ask the target rather than
 * reuse the local profile list.
 */
export interface TargetProfilesResponse {
  profiles: TargetProfileSummary[];
}

/**
 * SSE stream: GET /api/events?token=...
 * Each event: `event: <type>` + `data: <json>`.
 */
export type ServerEvent =
  | { type: 'profiles-changed' }
  | { type: 'usage-updated'; profileId: string; snapshot: UsageSnapshot }
  | { type: 'sessions-changed'; sessions: TerminalSession[] };
