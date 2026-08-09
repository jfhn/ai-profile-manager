/**
 * The local transport — the machine the daemon itself runs on.
 *
 * It is the default target everywhere and the reference implementation of the
 * transport contract: everything a remote transport has to do is done here
 * against real processes, real ptys and real loopback ports. Commands are
 * always spawned from argv with `shell: false`, so no caller-supplied string
 * can ever reach a shell.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { spawn as spawnPty, type IPty } from 'node-pty';
import {
  LOCAL_TARGET_ID,
  TARGET_CAPABILITIES,
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
} from '@apm/shared';
import type { ProfileService } from '../context.js';
import { allocatePort, httpProbe } from './net.js';

const DEFAULT_TERM = 'xterm-256color';
const DEFAULT_HEALTH_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 500;

export interface LocalTransportDeps {
  /** Profiles live on this machine; only their env is ever applied, never exported. */
  profiles: Pick<ProfileService, 'list' | 'envFor'>;
  /** Health poll interval for endpoints (tests shorten it). */
  pollIntervalMs?: number;
}

/** The always-present local target. Approved by definition, all capabilities. */
export function createLocalTarget(): ExecutionTarget {
  return {
    id: LOCAL_TARGET_ID,
    label: os.hostname() || 'this machine',
    kind: 'local',
    transport: 'local',
    identity: { hostname: os.hostname() || null, address: null, fingerprint: null },
    capabilities: [...TARGET_CAPABILITIES],
    approved: true,
    status: 'online',
  };
}

export function createLocalTransport(deps: LocalTransportDeps): TargetTransport {
  const target = createLocalTarget();
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  /** argv + env + cwd, validated on this machine before anything is spawned. */
  function prepare(spec: CommandSpec): {
    command: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
  } {
    const command = spec.argv[0];
    if (command === undefined) {
      throw fail('spawn-failed', 'A command needs at least argv[0]');
    }
    const profileEnv = spec.profileId ? deps.profiles.envFor(spec.profileId) : {};
    const env = { ...process.env, ...profileEnv, ...spec.env };

    const cwd = spec.cwd ?? os.homedir();
    if (!isDirectory(cwd)) {
      throw fail('cwd-not-found', `Working directory does not exist: ${cwd}`);
    }
    if (!isExecutable(command, env.PATH)) {
      throw fail('command-not-found', `Command not found: ${command}`);
    }
    return { command, args: spec.argv.slice(1), cwd, env };
  }

  return {
    target,

    supports(capability: TargetCapability) {
      return target.capabilities.includes(capability);
    },

    async probe(): Promise<TargetStatus> {
      return 'online';
    },

    // async so a rejected precondition surfaces as a rejection, never a throw.
    async exec(spec: CommandSpec, options: ExecOptions = {}): Promise<CommandResult> {
      const { command, args, cwd, env } = prepare(spec);
      return new Promise<CommandResult>((resolve, reject) => {
        // shell: false is the whole point — argv stays argv.
        const child = spawn(command, args, { cwd, env, shell: false });
        let stdout = '';
        let stderr = '';
        let settled = false;
        const timer =
          options.timeoutMs === undefined
            ? null
            : setTimeout(() => {
                if (settled) return;
                settled = true;
                child.kill('SIGKILL');
                reject(fail('timeout', `${command} did not finish within ${options.timeoutMs}ms`));
              }, options.timeoutMs);

        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => void (stdout += chunk));
        child.stderr?.on('data', (chunk: string) => void (stderr += chunk));
        // A command that exits without reading stdin makes the write EPIPE.
        child.stdin?.on('error', () => undefined);
        child.stdin?.end(options.stdin ?? '');

        child.on('error', (error: Error) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          reject(fail('spawn-failed', `Could not start ${command}: ${error.message}`, error));
        });
        child.on('close', (code, signal) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          resolve({ exitCode: code, signal, stdout, stderr });
        });
      });
    },

    async openPty(spec: PtySpec): Promise<PtyHandle> {
      const { command, args, cwd, env } = prepare(spec);
      let pty: IPty;
      try {
        pty = spawnPty(command, args, {
          name: spec.term ?? DEFAULT_TERM,
          cols: spec.cols,
          rows: spec.rows,
          cwd,
          env,
        });
      } catch (error: unknown) {
        throw fail(
          'spawn-failed',
          `Could not start ${command}: ${error instanceof Error ? error.message : String(error)}`,
          error,
        );
      }
      return localPtyHandle(pty);
    },

    async openEndpoint(request: EndpointRequest): Promise<EndpointHandle> {
      const port = request.port ?? (await allocatePort());
      if (port === null) {
        throw fail('endpoint-failed', 'No free local port available');
      }
      return localEndpointHandle(request, port, pollIntervalMs);
    },

    async profiles(): Promise<TargetProfileSummary[]> {
      return deps.profiles.list().map((profile) => ({
        id: profile.id,
        provider: profile.provider,
        label: profile.label,
        status: profile.status,
        enabled: profile.enabled,
      }));
    },

    async close(): Promise<void> {
      // Nothing to disconnect: ptys and endpoints belong to their callers.
    },
  };
}

function localPtyHandle(pty: IPty): PtyHandle {
  const dataListeners = new Set<(data: string) => void>();
  const errorListeners = new Set<(error: TransportError) => void>();
  const exitListeners = new Set<(status: ExitStatus) => void>();
  let exited: ExitStatus | null = null;

  pty.onData((data) => {
    for (const listener of dataListeners) listener(data);
  });
  pty.onExit(({ exitCode, signal }) => {
    const normalizedSignal = signalName(signal);
    exited = { exitCode: normalizedSignal === null ? exitCode : null, signal: normalizedSignal };
    for (const listener of exitListeners) listener(exited);
    errorListeners.clear();
    exitListeners.clear();
  });

  return {
    id: `local-pty-${pty.pid}`,
    targetId: LOCAL_TARGET_ID,

    write(data) {
      if (exited) return;
      pty.write(data);
    },

    resize(cols, rows) {
      if (exited) return;
      try {
        pty.resize(cols, rows);
      } catch {
        /* pty already gone — the caller's recorded size is still useful */
      }
    },

    signal(signal: TargetSignal) {
      if (exited) return;
      try {
        pty.kill(signal);
      } catch {
        /* already dead */
      }
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
      if (exited) return;
      try {
        pty.kill();
      } catch {
        /* already dead */
      }
    },
  };
}

/**
 * Local "forwarding" is a no-op: the service already listens on this machine,
 * so the endpoint is its loopback URL plus the health probe on top. The URL
 * appears once the service actually answers, exactly like a remote forward.
 */
function localEndpointHandle(
  request: EndpointRequest,
  port: number,
  pollIntervalMs: number,
): EndpointHandle {
  const protocol = request.protocol ?? 'http';
  const healthPath = request.healthPath ?? '/';
  const url = `${protocol}://127.0.0.1:${port}`;
  const endpoint: ServiceEndpoint = {
    id: crypto.randomUUID(),
    targetId: LOCAL_TARGET_ID,
    port,
    protocol,
    url: null,
    scope: 'loopback',
  };
  const closeListeners = new Set<(reason: string | null) => void>();
  let closed = false;

  async function check(): Promise<EndpointHealth> {
    const checkedAt = new Date().toISOString();
    if (closed) return { state: 'closed', checkedAt, reason: null };
    if (await httpProbe({ port, path: healthPath })) {
      endpoint.url = url;
      return { state: 'healthy', checkedAt, reason: null };
    }
    return {
      state: 'unhealthy',
      checkedAt,
      reason: `No HTTP response on 127.0.0.1:${port}${healthPath}`,
    };
  }

  return {
    endpoint,
    health: check,

    async waitUntilHealthy(timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS) {
      const deadline = Date.now() + timeoutMs;
      let last = await check();
      while (last.state !== 'healthy' && last.state !== 'closed' && Date.now() < deadline) {
        await sleep(pollIntervalMs);
        last = await check();
      }
      return last;
    },

    onClose(listener) {
      closeListeners.add(listener);
      return () => void closeListeners.delete(listener);
    },

    async close() {
      if (closed) return;
      closed = true;
      endpoint.url = null;
      for (const listener of closeListeners) listener(null);
      closeListeners.clear();
    },
  };
}

function fail(code: TransportError['code'], message: string, cause?: unknown): TransportError {
  return new TransportError(code, LOCAL_TARGET_ID, message, { cause });
}

/** node-pty reports the signal number; the contract speaks signal names. */
function signalName(signal: number | undefined): string | null {
  if (signal === undefined || signal === 0) return null;
  for (const [name, number] of Object.entries(os.constants.signals)) {
    if (number === signal) return name;
  }
  return String(signal);
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** PATH lookup so a typo fails up front instead of as an instant exit. */
function isExecutable(command: string, pathEnv: string | undefined): boolean {
  if (command.includes('/')) return canExecute(command);
  for (const dir of (pathEnv ?? '').split(path.delimiter)) {
    if (dir && canExecute(path.join(dir, command))) return true;
  }
  return false;
}

function canExecute(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
