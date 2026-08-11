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
 * Four jobs, deliberately kept separate:
 *   - one-shot commands   (exec)
 *   - interactive ptys    (openPty)
 *   - service endpoints   (openEndpoint) for HTTP/WS apps such as T3
 *   - detached services   (spawnDetached / inspectDetached / stopDetached),
 *     the managed-T3 exception to "nothing outlives the connection": the
 *     process runs in its own session on the target, is recorded in a state
 *     file inside its base dir, and is re-linked by pid after a daemon restart
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
 * A managed service to spawn *detached* on the target — its own session and
 * process group, so it survives the transport connection and the daemon that
 * asked for it. This is deliberately the only way a transport starts anything
 * that outlives it, and it is scoped to managed T3 instances: the target
 * refuses a base dir that is not an immediate child of its managed T3
 * directory named after the instance.
 */
export interface DetachedServiceSpec extends CommandSpec {
  /** Opaque instance id; must equal the base dir's final path segment. */
  instanceId: string;
  /** Loopback port the service is expected to bind on the target. */
  port: number;
  /** Instance-private base dir on the target; the state record lives inside. */
  baseDir: string;
}

/**
 * What the target records about a live detached service. Only opaque ids,
 * pids and ports — never credentials, never the process's output.
 */
export interface DetachedServiceState {
  instanceId: string;
  pid: number;
  port: number;
  /** ISO timestamp of the spawn. */
  startedAt: string;
}

export interface DetachedServiceInspection {
  /** The recorded state, when the recorded pid is verifiably still that process. */
  state: DetachedServiceState | null;
  /** Why `state` is null when it is (process exited, nothing recorded, ...). */
  reason: string | null;
}

export type EndpointProtocol = 'http' | 'https';

/** How the endpoint's URL is reachable from the machine running the daemon. */
export type EndpointScope =
  /** The service runs here; the URL is its own loopback address. */
  | 'loopback'
  /** The transport forwards a local port to the target's port. */
  | 'forwarded'
  /** The transport publishes the target's own address (e.g. a tailnet name). */
  | 'published';

export interface EndpointRequest {
  /** Port on the target; null asks the target to allocate a free one. */
  port: number | null;
  protocol?: EndpointProtocol;
  /** Path probed by health checks; defaults to '/'. */
  healthPath?: string;
  /** Human label for diagnostics and logs. */
  label?: string;
  /**
   * The published endpoint deliberately outlives this transport connection
   * (a detached service is behind it), so closing the transport must not
   * withdraw it. `EndpointHandle.close()` still does.
   */
  persistent?: boolean;
}

export interface ServiceEndpoint {
  id: string;
  targetId: TargetId;
  /** The port the service listens on *on the target*. */
  port: number;
  protocol: EndpointProtocol;
  /** URL usable from this machine (browser included); null until reachable. */
  url: string | null;
  scope: EndpointScope;
}

export type EndpointHealthState = 'starting' | 'healthy' | 'unhealthy' | 'closed';

export interface EndpointHealth {
  state: EndpointHealthState;
  /** ISO timestamp of the check. */
  checkedAt: string;
  /** Why it is not healthy, when it is not. */
  reason: string | null;
}

export interface EndpointHandle {
  /** Snapshot; `url` is filled in as soon as the endpoint is reachable. */
  readonly endpoint: ServiceEndpoint;
  /** Probe now. */
  health(): Promise<EndpointHealth>;
  /** Poll until healthy or the timeout elapses; resolves with the last health. */
  waitUntilHealthy(timeoutMs?: number): Promise<EndpointHealth>;
  /** Fires when the transport tears the endpoint down (or close() is called). */
  onClose(listener: (reason: string | null) => void): () => void;
  /** Stop forwarding/publishing. Never stops the service itself. */
  close(): Promise<void>;
}

export interface TargetTransport {
  readonly target: ExecutionTarget;
  supports(capability: TargetCapability): boolean;
  /** Cheap reachability probe. Reports 'offline' instead of throwing. */
  probe(): Promise<TargetStatus>;
  /** Run argv to completion. A non-zero exit is a result, not an error. */
  exec(spec: CommandSpec, options?: ExecOptions): Promise<CommandResult>;
  openPty(spec: PtySpec): Promise<PtyHandle>;
  openEndpoint(request: EndpointRequest): Promise<EndpointHandle>;
  /**
   * Spawn a managed service detached on the target and record it there. The
   * process belongs to the *target* afterwards, not to this connection: it
   * survives close(), agent death and a daemon restart, and is reached again
   * only through inspectDetached/stopDetached.
   */
  spawnDetached(spec: DetachedServiceSpec): Promise<DetachedServiceState>;
  /**
   * Re-read the recorded state of a detached service. `state` is null unless
   * the recorded pid verifiably still is that process — a recycled pid is
   * reported as gone, never as the service.
   */
  inspectDetached(instanceId: string, baseDir: string): Promise<DetachedServiceInspection>;
  /**
   * Terminate the recorded detached service (SIGTERM, then SIGKILL, delivered
   * to its process group) and drop the record. Idempotent: nothing recorded or
   * an already-dead process is a clean no-op. Never kills a pid it cannot
   * verify as the recorded process.
   */
  stopDetached(instanceId: string, baseDir: string): Promise<void>;
  /** Profiles as the target sees them — no homes, no credentials. */
  profiles(): Promise<TargetProfileSummary[]>;
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
  /** Forwarding/publishing the endpoint failed. */
  'endpoint-failed',
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
