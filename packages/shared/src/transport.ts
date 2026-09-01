import type { ProfileSync } from './profile.js';
import type { ProviderId } from './provider.js';
import type {
  ExecutionTarget,
  TargetCapability,
  TargetId,
  TargetProfileSummary,
  TargetStatus,
} from './target.js';

/**
 * Transport contract: the one seam every execution target is driven through.
 *
 * Two jobs, deliberately kept separate:
 *   - one-shot commands   (exec)
 *   - interactive ptys    (openPty)
 *
 * Everything crossing the seam is a structured value. There is no "command
 * line" anywhere in this file: a command is argv plus an env map plus a cwd,
 * so no user-controlled string is ever handed to a shell. Credentials never
 * cross either — a command names `profileIds` and the *target* injects those
 * profiles' provider env locally.
 */

/** A command to run on a target. argv only — never a shell string. */
export interface CommandSpec {
  /** argv[0] is the executable, resolved on the target's PATH. Never empty. */
  argv: readonly string[];
  /** Extra environment merged on top of the target's own environment. */
  env?: Readonly<Record<string, string>>;
  /** Absolute path on the target; defaults to the target user's home. */
  cwd?: string;
  /**
   * Profiles whose provider env the target injects (CLAUDE_CONFIG_DIR etc.),
   * merged in order — at most one per provider, which the caller enforces.
   * The resolved values never travel back: credentials stay on the target.
   */
  profileIds?: readonly string[];
}

export interface ExecOptions {
  /** Data written to stdin, then stdin is closed. */
  stdin?: string;
  /** Abort and reject with a 'timeout' TransportError once exceeded. */
  timeoutMs?: number;
}

/** How a process ended. Exactly one field is set; a signal always means a null exitCode. */
export interface ExitStatus {
  exitCode: number | null;
  /** Signal name (e.g. 'SIGHUP') when the process was killed. */
  signal: string | null;
}

export interface CommandResult extends ExitStatus {
  stdout: string;
  stderr: string;
}

export interface PtySpec extends CommandSpec {
  cols: number;
  rows: number;
  /** $TERM for the pty; defaults to 'xterm-256color'. */
  term?: string;
}

/** Signals a caller may deliver through a transport. */
export const TARGET_SIGNALS = ['SIGHUP', 'SIGINT', 'SIGTERM', 'SIGKILL'] as const;
export type TargetSignal = (typeof TARGET_SIGNALS)[number];

/**
 * A live interactive process. Listener registration returns its own
 * unsubscribe function; unsubscribing never affects the process.
 */
export interface PtyHandle {
  /** Transport-scoped handle id, for diagnostics. */
  readonly id: string;
  readonly targetId: TargetId;
  /** Forward input. A no-op once the process exited. */
  write(data: string): void;
  /** Tell the target the window changed. A no-op once the process exited. */
  resize(cols: number, rows: number): void;
  /** Deliver a signal to the process. A no-op once it exited. */
  signal(signal: TargetSignal): void;
  onData(listener: (data: string) => void): () => void;
  /** Runtime transport failure after the pty was opened. */
  onError(listener: (error: TransportError) => void): () => void;
  /** Fires exactly once. Late listeners receive the recorded status immediately. */
  onExit(listener: (status: ExitStatus) => void): () => void;
  /** Terminate the process if it is still running and release the handle. */
  close(): Promise<void>;
}

/**
 * A synced profile's credentials in transit. This is the only shape provider
 * credentials may ever cross a transport in, and only inside the three sync
 * messages — never in a session payload, HTTP response, event or log line.
 */
export interface CredentialBundle {
  provider: ProviderId;
  /** ISO-8601, derived from the credential file's mtime at read time. */
  rotatedAt: string;
  /** Provider-specific credential file subset; opaque outside that provider's adapter. */
  payload: Record<string, unknown>;
}

export interface SyncPushResult {
  /** False means the target already holds this rotation or a newer one. */
  applied: boolean;
}

/**
 * The one-time enrollment message used to create a synced replica on a
 * selected target. It carries only the profile label/provider and the
 * provider's credential bundle — never chats, caches, or the source home.
 */
export interface SyncEnrollment {
  sync: ProfileSync;
  provider: ProviderId;
  label: string;
  bundle: CredentialBundle;
}

export interface TargetTransport {
  readonly target: ExecutionTarget;
  supports(capability: TargetCapability): boolean;
  /** Cheap reachability probe. Reports 'offline' instead of throwing. */
  probe(): Promise<TargetStatus>;
  /** Run argv to completion. A non-zero exit is a result, not an error. */
  exec(spec: CommandSpec, options?: ExecOptions): Promise<CommandResult>;
  openPty(spec: PtySpec): Promise<PtyHandle>;
  /** Profiles as the target sees them — no homes, no credentials. */
  profiles(): Promise<TargetProfileSummary[]>;
  /** Fetch the credential bundle of the target's profile with this sync id. */
  syncPull(sync: ProfileSync): Promise<CredentialBundle>;
  /** Offer a rotated bundle; the target applies it only when strictly newer. */
  syncPush(sync: ProfileSync, bundle: CredentialBundle): Promise<SyncPushResult>;
  /** Create (or idempotently refresh) a replica for this sync id on the target. */
  syncEnroll(enrollment: SyncEnrollment): Promise<TargetProfileSummary>;
  /**
   * Release connection-level resources. Handles opened through this transport
   * belong to their caller and must be closed by it.
   */
  close(): Promise<void>;
}

export const TRANSPORT_ERROR_CODES = [
  /** No such target in the registry. */
  'target-not-found',
  /** A remote target that no human approved on this machine. */
  'target-not-approved',
  /** The target cannot do this (see ExecutionTarget.capabilities). */
  'unsupported',
  /** The target could not be reached at all. */
  'unreachable',
  /** The target refused our identity. */
  'unauthorized',
  /** The transport was closed (or the handle was). */
  'closed',
  /** No such profile on that target. */
  'profile-not-found',
  'cwd-not-found',
  'command-not-found',
  'spawn-failed',
  'timeout',
  /** Both machines claim the owner role for one sync id, or bundle/profile providers disagree. */
  'sync-conflict',
  /** The target has no synced profile (or no credential file) for that sync id. */
  'sync-not-enabled',
] as const;
export type TransportErrorCode = (typeof TRANSPORT_ERROR_CODES)[number];

/** Every transport failure — connection, lifecycle and execution alike. */
export class TransportError extends Error {
  constructor(
    public readonly code: TransportErrorCode,
    public readonly targetId: TargetId,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'TransportError';
  }
}

export function isTransportError(value: unknown): value is TransportError {
  return value instanceof TransportError;
}
