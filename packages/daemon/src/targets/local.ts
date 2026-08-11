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
import { z } from 'zod';
import {
  LOCAL_TARGET_ID,
  TARGET_CAPABILITIES,
  TransportError,
  type CommandResult,
  type CommandSpec,
  type DetachedServiceInspection,
  type DetachedServiceSpec,
  type DetachedServiceState,
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
import { resolveConfig } from '../config.js';
import { allocatePort, httpProbe } from './net.js';

const DEFAULT_TERM = 'xterm-256color';
const DEFAULT_HEALTH_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
/** SIGTERM grace before a detached service is SIGKILLed. Must stay well under
 * the SSH transport's per-request response timeout, or a slow shutdown would
 * read as an unreachable target. */
const DEFAULT_DETACHED_STOP_GRACE_MS = 5_000;
const DETACHED_KILL_WAIT_MS = 2_000;
const DETACHED_POLL_MS = 50;

/** State record for one detached service, inside its base dir. */
export const DETACHED_STATE_FILE = 'apm-service.json';

/**
 * What the target records about a detached service, plus the one field that
 * never crosses the wire: the pid's kernel start time. pid + start time is
 * unique per boot, so a recycled pid can never be mistaken for the service —
 * which is what makes killing by recorded pid safe at all.
 */
const detachedRecordSchema = z.object({
  version: z.literal(1),
  instanceId: z.string().min(1),
  pid: z.number().int().positive(),
  port: z.number().int(),
  startedAt: z.string(),
  /** Linux /proc start time in clock ticks; null when it could not be read. */
  startTicks: z.number().nullable(),
});
type DetachedRecord = z.infer<typeof detachedRecordSchema>;

export interface LocalTransportDeps {
  /** Profiles live on this machine; only their env is ever applied, never exported. */
  profiles: Pick<ProfileService, 'list' | 'envFor'>;
  /** Health poll interval for endpoints (tests shorten it). */
  pollIntervalMs?: number;
  /**
   * Directory whose immediate children are the managed T3 base dirs; only
   * those may host a detached service. Defaults to this machine's own
   * `config.t3Dir`, which is also what `apm pair` scopes itself to.
   */
  detachedDir?: string;
  /** SIGTERM grace for stopDetached (tests shorten it). */
  detachedStopGraceMs?: number;
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
  const detachedStopGraceMs = deps.detachedStopGraceMs ?? DEFAULT_DETACHED_STOP_GRACE_MS;
  // Resolved lazily so a transport that never touches detached services never
  // reads the daemon config either.
  const detachedRoot = () => path.resolve(deps.detachedDir ?? resolveConfig().t3Dir);

  /**
   * The narrow scope of the detached exception: only an immediate child of the
   * managed T3 directory, named after its instance, may host one. Everything
   * else keeps the nothing-outlives-the-connection contract.
   */
  function requireManagedBaseDir(instanceId: string, baseDir: string): string {
    const resolved = path.resolve(baseDir);
    if (path.basename(resolved) !== instanceId || path.dirname(resolved) !== detachedRoot()) {
      throw fail(
        'spawn-failed',
        `A detached service must live in an immediate child of ${detachedRoot()} named after ` +
          `its instance; refusing ${baseDir} for instance ${instanceId}`,
      );
    }
    if (!isDirectory(resolved)) {
      throw fail('cwd-not-found', `Base directory does not exist: ${resolved}`);
    }
    return resolved;
  }

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
    // One env per bound profile, merged in the order the spec names them; the
    // caller binds at most one profile per provider, so nothing collides.
    const profileEnv: Record<string, string> = {};
    for (const profileId of spec.profileIds ?? []) {
      Object.assign(profileEnv, deps.profiles.envFor(profileId));
    }
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

    async spawnDetached(spec: DetachedServiceSpec): Promise<DetachedServiceState> {
      const { command, args, cwd, env } = prepare(spec);
      const baseDir = requireManagedBaseDir(spec.instanceId, spec.baseDir);
      const stateFile = path.join(baseDir, DETACHED_STATE_FILE);
      const existing = readDetachedRecord(stateFile, spec.instanceId);
      if (existing && verifyRecorded(existing) === 'ours') {
        throw fail(
          'spawn-failed',
          `Instance ${spec.instanceId} is already running as pid ${existing.pid} — stop it first`,
        );
      }
      let child;
      try {
        // detached => its own session and process group: this one process
        // class is *meant* to outlive the agent and the daemon. Its output is
        // discarded on purpose — t3's startup output carries a one-time
        // pairing token, which must never land in a file or on the wire.
        child = spawn(command, args, { cwd, env, detached: true, stdio: 'ignore' });
      } catch (error: unknown) {
        throw fail(
          'spawn-failed',
          `Could not start ${command}: ${error instanceof Error ? error.message : String(error)}`,
          error,
        );
      }
      child.on('error', () => undefined);
      child.unref();
      const pid = child.pid;
      if (pid === undefined) {
        throw fail('spawn-failed', `Could not start ${command}: no pid was assigned`);
      }
      const state: DetachedServiceState = {
        instanceId: spec.instanceId,
        pid,
        port: spec.port,
        startedAt: new Date().toISOString(),
      };
      // Recorded immediately, while the pid is certainly still this child; a
      // null start time (process already gone, or no /proc) fails closed later.
      writeDetachedRecord(stateFile, { version: 1, ...state, startTicks: processStartTicks(pid) });
      return state;
    },

    async inspectDetached(instanceId: string, baseDir: string): Promise<DetachedServiceInspection> {
      const dir = requireManagedBaseDir(instanceId, baseDir);
      const record = readDetachedRecord(path.join(dir, DETACHED_STATE_FILE), instanceId);
      if (!record) {
        return { state: null, reason: 'no detached process is recorded in the base dir' };
      }
      switch (verifyRecorded(record)) {
        case 'ours':
          return {
            state: {
              instanceId: record.instanceId,
              pid: record.pid,
              port: record.port,
              startedAt: record.startedAt,
            },
            reason: null,
          };
        case 'gone':
          return { state: null, reason: `recorded process ${record.pid} is no longer running` };
        default:
          // Alive but unverifiable is reported as gone rather than linked:
          // claiming a pid we cannot prove is the service would be a lie.
          return {
            state: null,
            reason: `pid ${record.pid} cannot be verified as the recorded process`,
          };
      }
    },

    async stopDetached(instanceId: string, baseDir: string): Promise<void> {
      const dir = requireManagedBaseDir(instanceId, baseDir);
      const stateFile = path.join(dir, DETACHED_STATE_FILE);
      const record = readDetachedRecord(stateFile, instanceId);
      if (!record) return; // nothing recorded — idempotent by design
      const verdict = verifyRecorded(record);
      if (verdict === 'gone') {
        removeQuietly(stateFile);
        return;
      }
      if (verdict === 'unverifiable') {
        // Killing is the one destructive step, so it demands proof: a pid that
        // is alive but cannot be tied to the record might be a recycled pid
        // belonging to something else entirely.
        throw fail(
          'unsupported',
          `pid ${record.pid} cannot be verified as instance ${instanceId} — not killing it. ` +
            'Detached services require Linux /proc; stop the process by hand.',
        );
      }
      // The child is a session leader (spawned detached), so its pid is its
      // process-group id: signalling the group reaches anything it spawned.
      killProcessGroup(record.pid, 'SIGTERM');
      await waitUntilGone(record.pid, detachedStopGraceMs);
      if (processAlive(record.pid)) {
        killProcessGroup(record.pid, 'SIGKILL');
        await waitUntilGone(record.pid, DETACHED_KILL_WAIT_MS);
      }
      if (processAlive(record.pid)) {
        throw fail('spawn-failed', `Could not stop pid ${record.pid} of instance ${instanceId}`);
      }
      removeQuietly(stateFile);
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
      // A pty child is a session leader, so its pid is also its process-group
      // id: signalling the group reaches anything the child spawned, which a
      // kill of the child alone would leave behind holding its ports.
      killProcessGroup(pty.pid, 'SIGHUP');
      try {
        pty.kill();
      } catch {
        /* already dead */
      }
    },
  };
}

/**
 * Signal a whole process group, best effort. Used on teardown so no descendant
 * of a pty outlives the handle that owns it — an orphaned server would keep
 * its port and answer requests nobody is supervising any more.
 */
export function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  if (!Number.isInteger(pid) || pid <= 1) return;
  try {
    process.kill(-pid, signal);
  } catch {
    /* no such group, or it is already gone */
  }
}

// ---- detached service records ----------------------------------------------

function readDetachedRecord(stateFile: string, instanceId: string): DetachedRecord | null {
  try {
    const parsed = detachedRecordSchema.safeParse(JSON.parse(fs.readFileSync(stateFile, 'utf8')));
    if (!parsed.success || parsed.data.instanceId !== instanceId) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

function writeDetachedRecord(stateFile: string, record: DetachedRecord): void {
  const tmp = `${stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, stateFile);
}

function removeQuietly(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    /* already gone */
  }
}

/**
 * Is the recorded pid still the recorded process?
 *   - 'ours':        alive, and its kernel start time matches the record.
 *   - 'gone':        no such process, or the pid was recycled by another one.
 *   - 'unverifiable': alive, but no start time to compare (no /proc, or the
 *     record was written without one). Callers must fail closed on this.
 */
function verifyRecorded(record: DetachedRecord): 'ours' | 'gone' | 'unverifiable' {
  if (!processAlive(record.pid)) return 'gone';
  const ticks = processStartTicks(record.pid);
  if (record.startTicks === null || ticks === null) return 'unverifiable';
  return ticks === record.startTicks ? 'ours' : 'gone';
}

/**
 * Kernel start time of a process in clock ticks since boot, from Linux
 * /proc/<pid>/stat. pid + start time identifies a process uniquely per boot,
 * which argv comparison cannot (two runs share an argv). Null when unreadable.
 */
function processStartTicks(pid: number): number | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // The comm field may contain spaces and parentheses; the fixed-format
    // fields resume after the *last* ')'. starttime is field 22 overall,
    // i.e. the 20th after pid and comm.
    const tail = stat.slice(stat.lastIndexOf(')') + 2).trimStart().split(/\s+/);
    const ticks = Number(tail[19]);
    return Number.isFinite(ticks) ? ticks : null;
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitUntilGone(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (processAlive(pid) && Date.now() < deadline) await sleep(DETACHED_POLL_MS);
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
