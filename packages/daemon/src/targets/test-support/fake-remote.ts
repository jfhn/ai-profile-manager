/** A deterministic in-memory remote transport for target and session tests. */
import {
  TransportError,
  type CommandResult,
  type CommandSpec,
  type ExecOptions,
  type ExecutionTarget,
  type ExitStatus,
  type PtyHandle,
  type PtySpec,
  type TargetCapability,
  type TargetProfileSummary,
  type TargetSignal,
  type TargetStatus,
  type TargetTransport,
  type TransportErrorCode,
} from '@apm/shared';

const DEFAULT_ID = 'fake-remote';

export interface FakeRemoteOptions {
  id?: string;
  label?: string;
  approved?: boolean;
  online?: boolean;
  capabilities?: TargetCapability[];
  profiles?: TargetProfileSummary[];
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
  emit(data: string): void;
  exit(status?: Partial<ExitStatus>): void;
  fail(code: TransportErrorCode, message?: string): void;
  readonly exited: boolean;
}

export interface FakeRemoteTransport extends TargetTransport {
  readonly execs: FakeExecCall[];
  readonly ptys: FakePty[];
  scriptExec(argv: readonly string[], result: Partial<CommandResult>): void;
  scriptFailure(argv: readonly string[], code: TransportErrorCode, message?: string): void;
  setOnline(online: boolean): void;
  setApproved(approved: boolean): void;
  lastPty(): FakePty;
}

export function createFakeRemoteTransport(options: FakeRemoteOptions = {}): FakeRemoteTransport {
  const id = options.id ?? DEFAULT_ID;
  const target: ExecutionTarget = {
    id,
    label: options.label ?? 'fake remote',
    kind: 'remote',
    transport: 'fake',
    identity: { hostname: id, address: `${id}.example`, fingerprint: `fp-${id}` },
    capabilities: options.capabilities ?? ['exec', 'pty', 'signal', 'profiles'],
    approved: options.approved ?? true,
    status: options.online === false ? 'offline' : 'online',
  };
  const execs: FakeExecCall[] = [];
  const ptys: FakePty[] = [];
  const results = new Map<string, Partial<CommandResult>>();
  const failures = new Map<string, TransportError>();
  const profiles = options.profiles ?? [];
  let online = options.online ?? true;
  let closed = false;

  function key(argv: readonly string[]): string {
    return argv.join('\u0000');
  }

  function guard(capability: TargetCapability): void {
    if (closed) throw new TransportError('closed', id, `Connection to "${id}" is closed`);
    if (!online) throw new TransportError('unreachable', id, `Target "${id}" is unreachable`);
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
        if (!exited) writes.push(data);
      },
      resize(cols, rows) {
        if (!exited) resizes.push({ cols, rows });
      },
      signal(signal) {
        if (!exited) signals.push(signal);
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
        if (!exited) for (const listener of dataListeners) listener(data);
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

  return {
    target,
    execs,
    ptys,
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
    async profiles(): Promise<TargetProfileSummary[]> {
      guard('profiles');
      return profiles.map((profile) => ({ ...profile }));
    },
    async close(): Promise<void> {
      closed = true;
      for (const pty of ptys) await pty.handle.close();
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
  };
}
