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
  type DetachedServiceInspection,
  type DetachedServiceSpec,
  type DetachedServiceState,
  type EndpointHandle,
  type EndpointHealth,
  type EndpointRequest,
  type EndpointScope,
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
/** Health re-check cadence; short enough that a polling wait stays instant. */
const DEFAULT_HEALTH_POLL_MS = 5;
const DEFAULT_HEALTH_TIMEOUT_MS = 30_000;

export interface FakeRemoteOptions {
  id?: string;
  label?: string;
  approved?: boolean;
  online?: boolean;
  capabilities?: TargetCapability[];
  profiles?: TargetProfileSummary[];
  /** First port handed out when the caller lets the target choose. */
  portBase?: number;
  /** How endpoints are reached; a forward through this machine by default. */
  endpointScope?: EndpointScope;
  /** Host in the endpoint URL — the target's own name for a published scope. */
  endpointHost?: string;
  /** Poll cadence of `waitUntilHealthy` (tests that flip health mid-wait). */
  healthPollIntervalMs?: number;
  /**
   * The target's record of detached services. It models state that lives *on
   * the target machine*, so a test that simulates a daemon restart hands the
   * same map to the next fake transport.
   */
  detachedStore?: Map<string, FakeDetachedService>;
  /** Model an agent too old for the detached verbs. */
  detachedUnsupported?: boolean;
}

/** One detached service as the fake target records it. */
export interface FakeDetachedService {
  state: DetachedServiceState;
  spec: DetachedServiceSpec;
  alive: boolean;
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
  /** The target-side record of detached services (shared across "restarts"). */
  readonly detached: Map<string, FakeDetachedService>;
  /** Every spawnDetached call, in order. */
  readonly detachedSpawns: DetachedServiceSpec[];
  /** Every stopDetached call, in order. */
  readonly detachedStops: Array<{ instanceId: string; baseDir: string }>;
  /** Simulate the detached service dying on the target. */
  killDetached(instanceId: string): void;
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
    capabilities: options.capabilities ?? [
      'exec',
      'pty',
      'signal',
      'endpoint',
      'profiles',
      'detached',
    ],
    approved: options.approved ?? true,
    status: options.online === false ? 'offline' : 'online',
  };

  const execs: FakeExecCall[] = [];
  const ptys: FakePty[] = [];
  const endpoints: FakeEndpoint[] = [];
  const detached = options.detachedStore ?? new Map<string, FakeDetachedService>();
  const detachedSpawns: DetachedServiceSpec[] = [];
  const detachedStops: Array<{ instanceId: string; baseDir: string }> = [];
  let nextDetachedPid = 32_000 + detached.size;
  const results = new Map<string, Partial<CommandResult>>();
  const failures = new Map<string, TransportError>();
  const profiles = options.profiles ?? [];
  let portBase = options.portBase ?? DEFAULT_PORT_BASE;
  let online = options.online ?? true;
  let closed = false;
  const endpointScope = options.endpointScope ?? 'forwarded';
  const endpointHost = options.endpointHost ?? '127.0.0.1';
  const healthPollIntervalMs = options.healthPollIntervalMs ?? DEFAULT_HEALTH_POLL_MS;

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

  /** The detached verbs, gated like everything else plus the agent's age. */
  function guardDetached(): void {
    guard('detached');
    if (options.detachedUnsupported) {
      throw new TransportError(
        'unsupported',
        id,
        `The apm agent on target "${id}" is too old to manage detached T3 instances — ` +
          'update apm on the target',
      );
    }
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
    const url = `${protocol}://${endpointHost}:${port}`;
    const endpoint: ServiceEndpoint = {
      id: `fake-endpoint-${endpoints.length + 1}`,
      targetId: id,
      port,
      protocol,
      // A remote endpoint is reached through a local forward by default; a
      // 'published' target answers on its own address instead.
      url: null,
      scope: endpointScope,
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
      /**
       * Polls, so a caller that awaits this still sees a flip the test makes
       * afterwards. The cadence is a plain timer rather than a fake clock:
       * the state it re-reads is entirely test-driven, so the loop is
       * deterministic and never waits on anything real.
       */
      async waitUntilHealthy(timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS) {
        const deadline = Date.now() + timeoutMs;
        let last = snapshot();
        while (last.state !== 'healthy' && last.state !== 'closed' && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, healthPollIntervalMs));
          last = snapshot();
        }
        return last;
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
    detached,
    detachedSpawns,
    detachedStops,

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

    async spawnDetached(spec): Promise<DetachedServiceState> {
      guardDetached();
      scripted(spec.argv);
      const existing = detached.get(spec.instanceId);
      if (existing?.alive) {
        throw new TransportError(
          'spawn-failed',
          id,
          `Instance ${spec.instanceId} is already running as pid ${existing.state.pid}`,
        );
      }
      const state: DetachedServiceState = {
        instanceId: spec.instanceId,
        pid: nextDetachedPid++,
        port: spec.port,
        startedAt: new Date().toISOString(),
      };
      detached.set(spec.instanceId, { state, spec, alive: true });
      detachedSpawns.push(spec);
      return { ...state };
    },

    async inspectDetached(instanceId): Promise<DetachedServiceInspection> {
      guardDetached();
      const record = detached.get(instanceId);
      if (!record) {
        return { state: null, reason: 'no detached process is recorded in the base dir' };
      }
      if (!record.alive) {
        return { state: null, reason: `recorded process ${record.state.pid} is no longer running` };
      }
      return { state: { ...record.state }, reason: null };
    },

    async stopDetached(instanceId, baseDir): Promise<void> {
      guardDetached();
      detachedStops.push({ instanceId, baseDir });
      const record = detached.get(instanceId);
      if (!record) return; // idempotent, like the real target
      record.alive = false;
      detached.delete(instanceId);
    },

    async profiles(): Promise<TargetProfileSummary[]> {
      guard('profiles');
      return profiles.map((profile) => ({ ...profile }));
    },

    async close(): Promise<void> {
      closed = true;
      // Persistent endpoints front detached services and survive the
      // connection, exactly as the SSH transport leaves its serve entries up.
      for (const endpoint of endpoints) {
        if (!endpoint.request.persistent) await endpoint.handle.close();
      }
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

    killDetached(instanceId) {
      const record = detached.get(instanceId);
      if (record) record.alive = false;
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
