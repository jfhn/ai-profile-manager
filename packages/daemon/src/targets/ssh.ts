/**
 * SSH target transport. SSH starts one fixed apm agent; commands and terminal
 * traffic cross its stdio as structured JSON instead of a remote shell line.
 */
import readline from 'node:readline';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  TransportError,
  type CommandResult,
  type CommandSpec,
  type EndpointHandle,
  type EndpointRequest,
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
} from '@apm/shared';
import { urlProbe } from './net.js';
import {
  agentResponseSchema,
  encodeAgentMessage,
  type AgentRequest,
  type AgentResponse,
} from './protocol.js';
import { openTailscaleEndpoint } from './tailscale.js';

const CONNECT_TIMEOUT_SECONDS = 10;
const RESPONSE_TIMEOUT_MS = 15_000;
const CLOSE_TIMEOUT_MS = 2_000;

export interface SshTargetOptions {
  id: string;
  label: string;
  address: string;
  approved: boolean;
}

export function createSshTransport(options: SshTargetOptions): TargetTransport {
  // 'endpoint' is served by Tailscale on the target (see tailscale.ts). It is
  // declared unconditionally because capabilities are static and the picker
  // needs them before anything is started; a target without Tailscale fails
  // openEndpoint with a TransportError naming the prerequisite.
  const capabilities: TargetCapability[] = ['exec', 'pty', 'signal', 'endpoint', 'profiles'];
  const target: ExecutionTarget = {
    id: options.id,
    label: options.label,
    kind: 'remote',
    transport: 'ssh',
    identity: { hostname: null, address: options.address, fingerprint: null },
    capabilities,
    approved: options.approved,
    status: 'unknown',
  };
  const handles = new Set<PtyHandle>();
  /** Ports this transport published on the target, so two never collide. */
  const reservedPorts = new Set<number>();
  let closed = false;

  function guard(): void {
    if (closed) throw failure('closed', `Connection to target "${target.id}" is closed`);
  }

  /** Named so the endpoint can drive `tailscale` over the very same channel. */
  async function execOnTarget(
    spec: CommandSpec,
    execOptions: ExecOptions = {},
  ): Promise<CommandResult> {
    guard();
    const response = await oneShot({ type: 'exec', spec, options: execOptions }, 'result');
    return response.result;
  }

  return {
    target,
    supports: (capability) => capabilities.includes(capability),

    async probe(): Promise<TargetStatus> {
      if (closed) return 'offline';
      try {
        await oneShot({ type: 'probe' }, 'ready');
        target.status = 'online';
      } catch {
        target.status = 'offline';
      }
      return target.status;
    },

    exec: execOnTarget,

    async openPty(spec: PtySpec): Promise<PtyHandle> {
      guard();
      const connection = openAgent();
      const handle = await remotePtyHandle(connection, spec, target.id);
      handles.add(handle);
      handle.onExit(() => void handles.delete(handle));
      return handle;
    },

    async openEndpoint(request: EndpointRequest): Promise<EndpointHandle> {
      guard();
      // The service stays on the target's loopback address; Tailscale is what
      // makes it reachable, and it is driven over this same exec channel.
      return openTailscaleEndpoint(request, {
        targetId: target.id,
        exec: execOnTarget,
        probe: (url, timeoutMs) => urlProbe(url, timeoutMs),
        reserved: reservedPorts,
      });
    },

    async profiles(): Promise<TargetProfileSummary[]> {
      guard();
      const response = await oneShot({ type: 'profiles' }, 'profiles');
      return response.profiles;
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      for (const handle of [...handles]) await handle.close();
      handles.clear();
    },
  };

  async function oneShot<T extends 'ready' | 'profiles' | 'result'>(
    request: AgentRequest,
    expected: T,
  ): Promise<Extract<AgentResponse, { type: T }>> {
    guard();
    const child = openAgent();
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        child.kill();
        rejectOnce(failure('timeout', `Target "${target.id}" did not respond in time`));
      }, RESPONSE_TIMEOUT_MS);
      const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

      function rejectOnce(error: TransportError): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill();
        reject(error);
      }

      lines.on('line', (line) => {
        if (settled) return;
        const response = parseResponse(line);
        if (!response) return rejectOnce(failure('closed', `Invalid response from "${target.id}"`));
        if (response.type === 'error') {
          return rejectOnce(failure(response.code, response.message));
        }
        if (response.type !== expected) {
          return rejectOnce(failure('closed', `Unexpected response from "${target.id}"`));
        }
        settled = true;
        clearTimeout(timer);
        resolve(response as Extract<AgentResponse, { type: T }>);
      });
      child.on('error', () => rejectOnce(unreachable()));
      child.stdin.on('error', () => rejectOnce(unreachable()));
      child.on('close', () => {
        if (!settled) rejectOnce(unreachable());
      });
      child.stdin.end(encodeAgentMessage(request));
    });
  }

  function openAgent(): ChildProcessWithoutNullStreams {
    const child = spawn(
      'ssh',
      [
        '-T',
        '-o',
        'BatchMode=yes',
        '-o',
        `ConnectTimeout=${CONNECT_TIMEOUT_SECONDS}`,
        '--',
        options.address,
        'apm',
        '__target-agent',
      ],
      { shell: false, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    // Authentication diagnostics stay on the daemon side and cannot block the
    // child by filling an unread pipe.
    child.stderr.resume();
    return child;
  }

  function failure(code: TransportError['code'], message: string): TransportError {
    return new TransportError(code, target.id, message);
  }

  function unreachable(): TransportError {
    return failure('unreachable', `Target "${target.id}" is unreachable`);
  }
}

async function remotePtyHandle(
  child: ChildProcessWithoutNullStreams,
  spec: PtySpec,
  targetId: string,
): Promise<PtyHandle> {
  const dataListeners = new Set<(data: string) => void>();
  const errorListeners = new Set<(error: TransportError) => void>();
  const exitListeners = new Set<(status: ExitStatus) => void>();
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  let handleId = '';
  let exited: ExitStatus | null = null;
  let runtimeError: TransportError | null = null;
  let ready = false;
  let resolveReady: (() => void) | undefined;
  let rejectReady: ((error: TransportError) => void) | undefined;
  let resolveExit: (() => void) | undefined;
  const opened = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const exit = new Promise<void>((resolve) => void (resolveExit = resolve));
  const timer = setTimeout(() => {
    const error = failure('timeout', `Target "${targetId}" did not open a pty in time`);
    rejectReady?.(error);
    child.kill();
  }, RESPONSE_TIMEOUT_MS);

  function finish(status: ExitStatus): void {
    if (exited) return;
    exited = status.signal === null ? status : { exitCode: null, signal: status.signal };
    resolveExit?.();
    for (const listener of exitListeners) listener(exited);
    errorListeners.clear();
    exitListeners.clear();
  }

  function failure(code: TransportError['code'], message: string): TransportError {
    return new TransportError(code, targetId, message);
  }

  function transportFailed(error: TransportError): void {
    if (runtimeError) return;
    runtimeError = error;
    if (!ready) {
      rejectReady?.(error);
    } else for (const listener of errorListeners) listener(error);
    child.kill();
  }

  lines.on('line', (line) => {
    const response = parseResponse(line);
    if (!response) {
      return transportFailed(failure('closed', `Invalid response from "${targetId}"`));
    }
    switch (response.type) {
      case 'ready':
        if (ready) return;
        ready = true;
        handleId = response.handleId ?? `ssh-pty-${targetId}`;
        clearTimeout(timer);
        resolveReady?.();
        break;
      case 'data':
        for (const listener of dataListeners) listener(response.data);
        break;
      case 'error':
        transportFailed(failure(response.code, response.message));
        break;
      case 'exit':
        finish({ exitCode: response.exitCode, signal: response.signal });
        break;
      default:
        transportFailed(failure('closed', `Unexpected response from "${targetId}"`));
    }
  });
  child.on('error', () =>
    transportFailed(failure('unreachable', `Target "${targetId}" is unreachable`)),
  );
  child.stdin.on('error', () =>
    transportFailed(failure('unreachable', `Connection to target "${targetId}" was lost`)),
  );
  child.on('close', () => {
    clearTimeout(timer);
    if (!exited) {
      transportFailed(failure('unreachable', `Connection to target "${targetId}" was lost`));
      finish({ exitCode: 1, signal: null });
    }
  });
  child.stdin.write(encodeAgentMessage({ type: 'pty', spec }));

  await opened;

  const handle: PtyHandle = {
    get id() {
      return handleId;
    },
    targetId,
    write(data) {
      sendRequest({ type: 'input', data });
    },
    resize(cols, rows) {
      sendRequest({ type: 'resize', cols, rows });
    },
    signal(signal: TargetSignal) {
      sendRequest({ type: 'signal', signal });
    },
    onData(listener) {
      dataListeners.add(listener);
      return () => void dataListeners.delete(listener);
    },
    onError(listener) {
      if (runtimeError) {
        listener(runtimeError);
        return () => undefined;
      }
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
      if (exited) return;
      sendRequest({ type: 'close' });
      await Promise.race([
        exit,
        new Promise<void>((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS)),
      ]);
      if (!exited) child.kill();
    },
  };
  return handle;

  function sendRequest(request: AgentRequest): void {
    if (exited || runtimeError || child.stdin.destroyed) return;
    child.stdin.write(encodeAgentMessage(request));
  }
}

function parseResponse(line: string): AgentResponse | null {
  try {
    const parsed = agentResponseSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
