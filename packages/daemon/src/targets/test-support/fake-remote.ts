/**
 * A deterministic in-memory remote transport.
 *
 * It is the second implementation the contract is tested against: no sockets,
 * no processes, no timers — every byte of output, every exit and every health
 * flip is driven by the test. It also models the parts a real remote transport
 * has that the local one cannot have: an unreachable machine, an unapproved
 * machine and a closed connection.
 */
import {
  TransportError,
  type CommandResult,
  type CommandSpec,
  type EndpointHandle,
  type EndpointHealth,
  type EndpointRequest,
  type ExecOptions,
  type ExecutionTarget,
  type ExitStatus,
  type PtyHandle,
  type PtySpec,
  type ServiceEndpoint,
  type TargetCapability,
  type TargetProfileSummary,
  type TargetSignal,
  type TargetStatus,
  type TargetTransport,
  type TransportErrorCode,
} from '@apm/shared';

const DEFAULT_ID = 'fake-remote';
const DEFAULT_PORT_BASE = 9100;

export interface FakeRemoteOptions {
  id?: string;
  label?: string;
  approved?: boolean;
  online?: boolean;
  capabilities?: TargetCapability[];
  profiles?: TargetProfileSummary[];
  /** First port handed out when the caller lets the target choose. */
  portBase?: number;
}

export interface FakeExecCall {
  spec: CommandSpec;
  options: ExecOptions;
}

export interface FakePty {
  readonly handle: PtyHandle;
  readonly spec: PtySpec;
  readonly writes: string[];
  readonly resizes: Array<{ cols: number; rows: number }>;
  readonly signals: TargetSignal[];
  /** Push output to everyone attached to this pty. */
  emit(data: string): void;
  /** End the process with the given status (defaults to a clean exit). */
  exit(status?: Partial<ExitStatus>): void;
  /** Fail the live transport, then end the process as failed. */
  fail(code: TransportErrorCode, message?: string): void;
  readonly exited: boolean;
}

export interface FakeEndpoint {
  readonly handle: EndpointHandle;
  readonly request: EndpointRequest;
  setHealthy(healthy: boolean, reason?: string): void;
  /** The transport tore the endpoint down on its own (forward lost). */
  drop(reason: string): void;
  readonly closed: boolean;
}

export interface FakeRemoteTransport extends TargetTransport {
  readonly execs: FakeExecCall[];
  readonly ptys: FakePty[];
  readonly endpoints: FakeEndpoint[];
  /** Result returned for commands with exactly this argv. */
  scriptExec(argv: readonly string[], result: Partial<CommandResult>): void;
  /** Reject exec/openPty for exactly this argv with a transport error. */
  scriptFailure(argv: readonly string[], code: TransportErrorCode, message?: string): void;
  setOnline(online: boolean): void;
  setApproved(approved: boolean): void;
  lastPty(): FakePty;
  lastEndpoint(): FakeEndpoint;
}

export function createFakeRemoteTransport(options: FakeRemoteOptions = {}): FakeRemoteTransport {
  const id = options.id ?? DEFAULT_ID;
  const target: ExecutionTarget = {
    id,
    label: options.label ?? 'fake remote',
    kind: 'remote',
    transport: 'fake',
    identity: { hostname: id, address: `${id}.example`, fingerprint: `fp-${id}` },
    capabilities: options.capabilities ?? ['exec', 'pty', 'signal', 'endpoint', 'profiles'],
    approved: options.approved ?? true,
    status: options.online === false ? 'offline' : 'online',
  };

  const execs: FakeExecCall[] = [];
  const ptys: FakePty[] = [];
  const endpoints: FakeEndpoint[] = [];
  const results = new Map<string, Partial<CommandResult>>();
  const failures = new Map<string, TransportError>();
  const profiles = options.profiles ?? [];
  let portBase = options.portBase ?? DEFAULT_PORT_BASE;
  let online = options.online ?? true;
  let closed = false;

  /** Scripting key for one argv; NUL keeps entries containing spaces distinct. */
  function key(argv: readonly string[]): string {
    return argv.join('\u0000');
  }

  function guard(capability: TargetCapability): void {
    if (closed) {
      throw new TransportError('closed', id, `Connection to "${id}" is closed`);
    }
    if (!online) {
      throw new TransportError('unreachable', id, `Target "${id}" is unreachable`);
    }
    if (!target.capabilities.includes(capability)) {
      throw new TransportError('unsupported', id, `Target "${id}" cannot do ${capability}`);
    }
  }

  function scripted(argv: readonly string[]): void {
    const failure = failures.get(key(argv));
    if (failure) throw failure;
  }

  function makePty(spec: PtySpec, index: number): FakePty {
    const dataListeners = new Set<(data: string) => void>();
    const errorListeners = new Set<(error: TransportError) => void>();
    const exitListeners = new Set<(status: ExitStatus) => void>();
    const writes: string[] = [];
    const resizes: Array<{ cols: number; rows: number }> = [];
    const signals: TargetSignal[] = [];
    let exited: ExitStatus | null = null;

    function finish(status: Partial<ExitStatus>): void {
      if (exited) return;
      const signal = status.signal ?? null;
      exited = { exitCode: signal === null ? (status.exitCode ?? 0) : null, signal };
      for (const listener of exitListeners) listener(exited);
      errorListeners.clear();
      exitListeners.clear();
    }

    const handle: PtyHandle = {
      id: `fake-pty-${index}`,
      targetId: id,
      write(data) {
        if (exited) return;
        writes.push(data);
      },
      resize(cols, rows) {
        if (exited) return;
        resizes.push({ cols, rows });
      },
      signal(signal) {
        if (exited) return;
        signals.push(signal);
      },
      onData(listener) {
        dataListeners.add(listener);
        return () => void dataListeners.delete(listener);
      },
      onError(listener) {
        errorListeners.add(listener);
        return () => void errorListeners.delete(listener);
      },
      onExit(listener) {
        if (exited) {
          listener(exited);
          return () => undefined;
        }
        exitListeners.add(listener);
        return () => void exitListeners.delete(listener);
      },
      async close() {
        finish({ exitCode: null, signal: 'SIGHUP' });
      },
    };

    return {
      handle,
      spec,
      writes,
      resizes,
      signals,
      emit(data) {
        if (exited) return;
        for (const listener of dataListeners) listener(data);
      },
      exit: finish,
      fail(code, message) {
        if (exited) return;
        const error = new TransportError(code, id, message ?? `${code}: live pty`);
        for (const listener of errorListeners) listener(error);
        finish({ exitCode: 1, signal: null });
      },
      get exited() {
        return exited !== null;
      },
    };
  }

  function makeEndpoint(request: EndpointRequest, port: number): FakeEndpoint {
    const protocol = request.protocol ?? 'http';
    const url = `${protocol}://127.0.0.1:${port}`;
    const endpoint: ServiceEndpoint = {
      id: `fake-endpoint-${endpoints.length + 1}`,
      targetId: id,
      port,
      protocol,
      // A remote endpoint is reached through a local forward.
      url: null,
      scope: 'forwarded',
    };
    const closeListeners = new Set<(reason: string | null) => void>();
    let healthy = false;
    let reason: string | null = 'not started';
    let endpointClosed = false;

    function snapshot(): EndpointHealth {
      const checkedAt = new Date().toISOString();
      if (endpointClosed) return { state: 'closed', checkedAt, reason: null };
      if (healthy) return { state: 'healthy', checkedAt, reason: null };
      return { state: 'unhealthy', checkedAt, reason };
    }

    function shutDown(why: string | null): void {
      if (endpointClosed) return;
      endpointClosed = true;
      endpoint.url = null;
      for (const listener of closeListeners) listener(why);
      closeListeners.clear();
    }

    const handle: EndpointHandle = {
      endpoint,
      async health() {
        return snapshot();
      },
      async waitUntilHealthy() {
        return snapshot();
      },
      onClose(listener) {
        closeListeners.add(listener);
        return () => void closeListeners.delete(listener);
      },
      async close() {
        shutDown(null);
      },
    };

    return {
      handle,
      request,
      setHealthy(next, why) {
        healthy = next;
        reason = next ? null : (why ?? 'unhealthy');
        endpoint.url = next ? url : null;
      },
      drop(why) {
        healthy = false;
        reason = why;
        shutDown(why);
      },
      get closed() {
        return endpointClosed;
      },
    };
  }

  return {
    target,
    execs,
    ptys,
    endpoints,

    supports: (capability) => target.capabilities.includes(capability),

    async probe(): Promise<TargetStatus> {
      target.status = closed || !online ? 'offline' : 'online';
      return target.status;
    },

    async exec(spec, execOptions = {}): Promise<CommandResult> {
      guard('exec');
      scripted(spec.argv);
      execs.push({ spec, options: execOptions });
      const result = results.get(key(spec.argv)) ?? {};
      const signal = result.signal ?? null;
      return {
        exitCode: signal === null ? (result.exitCode ?? 0) : null,
        signal,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      };
    },

    async openPty(spec): Promise<PtyHandle> {
      guard('pty');
      scripted(spec.argv);
      const pty = makePty(spec, ptys.length + 1);
      ptys.push(pty);
      return pty.handle;
    },

    async openEndpoint(request): Promise<EndpointHandle> {
      guard('endpoint');
      const port = request.port ?? portBase++;
      const entry = makeEndpoint(request, port);
      endpoints.push(entry);
      return entry.handle;
    },

    async profiles(): Promise<TargetProfileSummary[]> {
      guard('profiles');
      return profiles.map((profile) => ({ ...profile }));
    },

    async close(): Promise<void> {
      closed = true;
      for (const endpoint of endpoints) await endpoint.handle.close();
    },

    scriptExec(argv, result) {
      results.set(key(argv), result);
    },

    scriptFailure(argv, code, message) {
      failures.set(key(argv), new TransportError(code, id, message ?? `${code}: ${argv[0]}`));
    },

    setOnline(next) {
      online = next;
      target.status = next ? 'online' : 'offline';
    },

    setApproved(next) {
      target.approved = next;
    },

    lastPty() {
      const pty = ptys[ptys.length - 1];
      if (!pty) throw new Error('no pty was opened');
      return pty;
    },

    lastEndpoint() {
      const endpoint = endpoints[endpoints.length - 1];
      if (!endpoint) throw new Error('no endpoint was opened');
      return endpoint;
    },
  };
}
