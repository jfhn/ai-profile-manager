/**
 * Managed T3 Code instances, local or on a remote execution target.
 *
 * Local instances are a detached `t3 serve --port <p> --base-dir <dir>` process
 * with the bound profiles' env — no PTY, supervised by port + health check.
 * Detached is deliberate: instances survive a daemon restart and are re-adopted
 * by `adopt()`, so `shutdown()` must never kill them. Nothing about that path
 * changed when targets arrived.
 *
 * Remote instances go through the target's transport and nothing else (no
 * second SSH/Tailscale path): `openPty` launches `t3 serve` from argv with the
 * bound profile's *id* — the target injects that profile's provider env, so no
 * credential ever reaches this machine — and `openEndpoint` publishes the port
 * and answers the health checks. The endpoint is also the only source of the
 * Open link: a remote instance is behind a forward or the target's own address,
 * never behind a URL this file assembled.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import {
  LOCAL_TARGET_ID,
  PROVIDER_IDS,
  providerIdSchema,
  type CreateT3InstanceRequest,
  type EndpointHandle,
  type EndpointHealth,
  type ExitStatus,
  type ProviderId,
  type PtyHandle,
  type T3Endpoint,
  type T3Instance,
  type TargetCapability,
  type TargetId,
  type TargetTransport,
} from '@apm/shared';
import type { DaemonConfig } from '../config.js';
import { ApiFailure, type EventBus, type ProfileService, type T3Manager } from '../context.js';
import { toApiFailure } from '../targets/errors.js';
import { httpProbe, portIsFree } from '../targets/net.js';
import type { TargetRegistry } from '../targets/registry.js';

/** First port tried for a new instance; T3's own default (4700) is left alone. */
export const T3_PORT_BASE = 4800;
const PORT_SCAN_LIMIT = 200;
const DEFAULT_START_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 500;

/** Resolved on the target's PATH — a remote target has its own installation. */
const REMOTE_T3_BINARY = 't3';
/** Instance base dirs on a target, relative to the target user's home. */
const REMOTE_BASE_SEGMENTS = ['.local', 'share', 'apm', 't3'];
/** A remote instance needs all four: launch, stop, publish, resolve profiles. */
const REMOTE_CAPABILITIES: TargetCapability[] = ['pty', 'signal', 'endpoint', 'profiles'];
/** Window `t3 serve` gets; it is a server, so the size only shapes its logging. */
const REMOTE_PTY_SIZE = { cols: 120, rows: 40 };

export interface T3SpawnRequest {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  logFile: string;
}

/** Every OS interaction is injectable so the manager is testable without T3. */
export interface T3ManagerDeps {
  resolveBinary?(name: string): string | null;
  spawnDetached?(req: T3SpawnRequest): number | null;
  /** True as soon as the port answers with any HTTP response. */
  healthCheck?(port: number): Promise<boolean>;
  isAlive?(pid: number): boolean;
  signal?(pid: number, signal: NodeJS.Signals): void;
  findPort?(exclude: ReadonlySet<number>): Promise<number>;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  pollIntervalMs?: number;
  /**
   * Execution targets. Only remote instances need it; without a registry the
   * manager serves the local target exactly as it always did.
   */
  targets?: TargetRegistry;
}

/** Live handles for one remote instance. Deliberately not persisted. */
interface RemoteRuntime {
  pty: PtyHandle;
  endpoint: EndpointHandle;
  /** Set while stop() is tearing the instance down, so it owns the final state. */
  stopping: boolean;
}

const endpointSchema = z.object({
  scope: z.enum(['loopback', 'forwarded', 'published']),
  protocol: z.enum(['http', 'https']),
  port: z.number().int(),
  url: z.string().nullable(),
});

const instanceSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  // Defaults keep a store written before targets existed readable.
  targetId: z.string().min(1).default(LOCAL_TARGET_ID),
  port: z.number().int().nullable(),
  baseDir: z.string().min(1),
  profiles: z.record(providerIdSchema, z.string()),
  status: z.enum(['stopped', 'starting', 'running', 'unhealthy', 'exited']),
  pid: z.number().int().nullable(),
  url: z.string().nullable(),
  endpoint: endpointSchema.nullable().default(null),
  statusReason: z.string().nullable(),
  createdAt: z.string(),
});

const storeFileSchema = z.object({
  version: z.literal(1),
  instances: z.array(instanceSchema),
});

export function createT3Manager(
  config: DaemonConfig,
  events: EventBus,
  profiles: ProfileService,
  deps: T3ManagerDeps = {},
): T3Manager {
  const resolveBinary = deps.resolveBinary ?? findOnPath;
  const spawnDetached = deps.spawnDetached ?? spawnDetachedProcess;
  const healthCheck = deps.healthCheck ?? ((port: number) => httpProbe({ port }));
  const isAlive = deps.isAlive ?? processAlive;
  const signal = deps.signal ?? ((pid, sig) => process.kill(pid, sig));
  const findPort = deps.findPort ?? ((exclude) => findFreePort(T3_PORT_BASE, exclude));
  const startTimeoutMs = deps.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  const stopTimeoutMs = deps.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const targets = deps.targets ?? null;

  const storeFile = path.join(config.t3Dir, 'instances.json');
  const instances = new Map<string, T3Instance>();
  for (const instance of readStore(storeFile)) instances.set(instance.id, instance);
  /** Health loops still running; shutdown() cancels them without touching the processes. */
  const watchers = new Set<{ cancelled: boolean }>();
  const remotes = new Map<string, RemoteRuntime>();

  function list(): T3Instance[] {
    return [...instances.values()].map((instance) => ({ ...instance }));
  }

  function persist(): void {
    writeJsonAtomic(storeFile, { version: 1, instances: list() });
  }

  function changed(): void {
    persist();
    events.emit({ type: 't3-changed', instances: list() });
  }

  function mustGet(id: string): T3Instance {
    const instance = instances.get(id);
    if (!instance) throw new ApiFailure(404, 't3-not-found', `No T3 instance ${id}`);
    return instance;
  }

  function logFileFor(id: string): string {
    return path.join(config.logsDir, `t3-${id}.log`);
  }

  /** Every bound profile must still exist, be active, and match its provider key. */
  function validateProfiles(bound: Partial<Record<ProviderId, string>>): Record<string, string> {
    const env: Record<string, string> = {};
    for (const provider of PROVIDER_IDS) {
      const profileId = bound[provider];
      if (!profileId) continue;
      const profile = profiles.get(profileId);
      if (!profile) {
        throw new ApiFailure(404, 'profile-not-found', `No profile ${profileId}`);
      }
      if (profile.provider !== provider) {
        throw new ApiFailure(
          409,
          'provider-mismatch',
          `Profile ${profile.label} is a ${profile.provider} profile, not ${provider}`,
        );
      }
      if (profile.status !== 'active' || !profile.enabled) {
        throw new ApiFailure(409, 'profile-not-active', `Profile ${profile.label} is not active`);
      }
      Object.assign(env, profiles.envFor(profile.id));
    }
    return env;
  }

  /** Ports are a per-target namespace: two targets may both use 4800. */
  function portsInUse(exceptId: string, targetId: TargetId): Set<number> {
    const used = new Set<number>();
    for (const instance of instances.values()) {
      if (instance.id === exceptId || instance.targetId !== targetId) continue;
      if (instance.port !== null && instance.status !== 'stopped') used.add(instance.port);
    }
    return used;
  }

  // ---- remote targets -------------------------------------------------------

  function requireTransport(targetId: TargetId): TargetTransport {
    if (!targets) {
      throw new ApiFailure(404, 'target-not-found', `No target "${targetId}" is configured`);
    }
    let transport: TargetTransport;
    try {
      transport = targets.transportFor(targetId);
    } catch (error: unknown) {
      throw toApiFailure(error);
    }
    const missing = REMOTE_CAPABILITIES.filter((capability) => !transport.supports(capability));
    if (missing.length > 0) {
      throw new ApiFailure(
        400,
        'target-unsupported',
        `Target "${targetId}" cannot host a T3 instance — it is missing: ${missing.join(', ')}`,
      );
    }
    return transport;
  }

  /**
   * One bound profile per remote instance: a CommandSpec carries a single
   * profileId, and the target's homes are the only place the env could be
   * resolved — there is no way to inject a second one without moving
   * credentials, which is exactly what the transport contract forbids.
   */
  async function resolveRemoteProfile(
    targetId: TargetId,
    bound: Partial<Record<ProviderId, string>>,
  ): Promise<{ provider: ProviderId; profileId: string }> {
    if (!targets) {
      throw new ApiFailure(404, 'target-not-found', `No target "${targetId}" is configured`);
    }
    const entries = PROVIDER_IDS.flatMap((provider) => {
      const profileId = bound[provider];
      return profileId ? [{ provider, profileId }] : [];
    });
    if (entries.length === 0) {
      throw new ApiFailure(400, 'bad-request', 'At least one profile is required');
    }
    if (entries.length > 1) {
      throw new ApiFailure(
        400,
        'multi-profile-unsupported',
        `An instance on target "${targetId}" binds one profile — its provider environment is ` +
          'resolved on the target, and a command carries a single profile',
      );
    }
    const [entry] = entries;
    if (!entry) throw new ApiFailure(400, 'bad-request', 'At least one profile is required');

    let summary;
    try {
      summary = await targets.resolveProfile(targetId, entry.profileId);
    } catch (error: unknown) {
      throw toApiFailure(error);
    }
    if (summary.provider !== entry.provider) {
      throw new ApiFailure(
        409,
        'provider-mismatch',
        `Profile ${summary.label} is a ${summary.provider} profile, not ${entry.provider}`,
      );
    }
    if (summary.status !== 'active' || !summary.enabled) {
      throw new ApiFailure(
        409,
        'profile-not-active',
        `Profile ${summary.label} is not active on target "${targetId}"`,
      );
    }
    return entry;
  }

  /**
   * The instance-private base dir is created *on the target*, under the target
   * user's own home — no path from this machine means anything over there.
   */
  async function createRemoteBaseDir(transport: TargetTransport, id: string): Promise<string> {
    const targetId = transport.target.id;
    let home: string;
    try {
      const result = await transport.exec({ argv: ['printenv', 'HOME'] });
      home = result.stdout.trim();
      if (result.exitCode !== 0 || !home.startsWith('/')) {
        throw new ApiFailure(
          502,
          'target-home-unknown',
          `Could not resolve the home directory on target "${targetId}"`,
        );
      }
      const baseDir = path.posix.join(home, ...REMOTE_BASE_SEGMENTS, id);
      const made = await transport.exec({ argv: ['mkdir', '-m', '700', '-p', baseDir] });
      if (made.exitCode !== 0) {
        throw new ApiFailure(
          502,
          'base-dir-failed',
          `Could not create ${baseDir} on target "${targetId}": ` +
            (made.stderr.trim() || `mkdir exited with ${made.exitCode}`),
        );
      }
      return baseDir;
    } catch (error: unknown) {
      if (error instanceof ApiFailure) throw error;
      throw toApiFailure(error);
    }
  }

  function snapshotEndpoint(handle: EndpointHandle): T3Endpoint {
    const { scope, protocol, port, url } = handle.endpoint;
    return { scope, protocol, port, url };
  }

  /** Detach a remote instance's handles without claiming anything about status. */
  function releaseRemote(id: string): void {
    const runtime = remotes.get(id);
    if (!runtime) return;
    remotes.delete(id);
    void runtime.endpoint.close().catch(() => undefined);
  }

  function onRemoteExit(id: string, status: ExitStatus): void {
    const instance = instances.get(id);
    const runtime = remotes.get(id);
    if (!instance || !runtime || runtime.stopping) return;
    releaseRemote(id);
    instance.status = 'exited';
    instance.pid = null;
    instance.url = null;
    instance.endpoint = null;
    // Only the exit status: t3's own output can contain its pairing token.
    instance.statusReason = `t3 ${describeExit(status)} on target "${instance.targetId}"`;
    changed();
  }

  function onEndpointClosed(id: string, reason: string | null): void {
    const instance = instances.get(id);
    const runtime = remotes.get(id);
    if (!instance || !runtime || runtime.stopping) return;
    if (instance.status !== 'running' && instance.status !== 'starting') return;
    instance.status = 'unhealthy';
    instance.url = null;
    instance.endpoint = null;
    instance.statusReason =
      `The endpoint on target "${instance.targetId}" closed` + (reason ? `: ${reason}` : '');
    changed();
  }

  async function startRemote(instance: T3Instance): Promise<T3Instance> {
    const targetId = instance.targetId;
    const transport = requireTransport(targetId);
    const { profileId } = await resolveRemoteProfile(targetId, instance.profiles);

    // Opened first: the target allocates the port, which is per-target by
    // construction, and the request has to name that port on the command line.
    let endpoint: EndpointHandle;
    try {
      endpoint = await transport.openEndpoint({
        port: null,
        healthPath: '/',
        label: `t3 ${instance.label}`,
      });
    } catch (error: unknown) {
      throw toApiFailure(error);
    }

    const port = endpoint.endpoint.port;
    const scope = endpoint.endpoint.scope;
    if (scope === 'loopback') {
      await endpoint.close();
      throw new ApiFailure(
        502,
        'endpoint-failed',
        `Target "${targetId}" published a loopback endpoint — a remote instance is never ` +
          "reachable on this machine's own loopback address",
      );
    }
    if (portsInUse(instance.id, targetId).has(port)) {
      await endpoint.close();
      throw new ApiFailure(
        500,
        'no-free-port',
        `Target "${targetId}" handed out port ${port}, which another instance already uses`,
      );
    }

    let pty: PtyHandle;
    try {
      pty = await transport.openPty({
        argv: t3ServeArgv(REMOTE_T3_BINARY, port, instance.baseDir),
        cwd: instance.baseDir,
        // The target resolves this id to its own provider env locally.
        profileId,
        ...REMOTE_PTY_SIZE,
      });
    } catch (error: unknown) {
      await endpoint.close();
      throw toApiFailure(error);
    }
    // t3's startup output carries a one-time pairing token, so it is
    // deliberately neither read, stored nor logged here.

    const runtime: RemoteRuntime = { pty, endpoint, stopping: false };
    remotes.set(instance.id, runtime);
    pty.onExit((status) => onRemoteExit(instance.id, status));
    endpoint.onClose((reason) => onEndpointClosed(instance.id, reason));

    instance.status = 'starting';
    instance.pid = null;
    instance.port = port;
    instance.url = null;
    instance.endpoint = snapshotEndpoint(endpoint);
    instance.statusReason = null;
    changed();

    const watcher = { cancelled: false };
    watchers.add(watcher);
    let health: EndpointHealth;
    try {
      health = await endpoint.waitUntilHealthy(startTimeoutMs);
    } finally {
      watchers.delete(watcher);
    }
    // The process may have exited (or been stopped) while we waited.
    if (watcher.cancelled || remotes.get(instance.id) !== runtime) return { ...instance };
    // Same for the endpoint: onClose already recorded why it went away, and
    // that reason beats a generic "nothing answered in time".
    if (health.state === 'closed') return { ...instance };

    if (health.state === 'healthy') {
      instance.endpoint = snapshotEndpoint(endpoint);
      instance.url = instance.endpoint.url;
      if (instance.url === null) {
        // Healthy without a URL is a broken transport, not something to link to.
        instance.status = 'unhealthy';
        instance.statusReason = `Target "${targetId}" reported a healthy endpoint without a URL`;
      } else {
        instance.status = 'running';
        instance.statusReason = null;
      }
    } else {
      instance.status = 'unhealthy';
      instance.statusReason =
        health.reason ??
        `No HTTP response from t3 on target "${targetId}" within ` +
          `${Math.round(startTimeoutMs / 1000)}s`;
    }
    changed();
    return { ...instance };
  }

  async function stopRemote(instance: T3Instance): Promise<void> {
    const runtime = remotes.get(instance.id);
    if (!runtime) return;
    runtime.stopping = true;
    const exited = new Promise<void>((resolve) => runtime.pty.onExit(() => resolve()));
    runtime.pty.signal('SIGTERM');
    await settleWithin(exited, stopTimeoutMs);
    // A no-op once the process is gone, so an already-clean exit costs nothing.
    runtime.pty.signal('SIGKILL');
    await settleWithin(exited, Math.min(2_000, stopTimeoutMs));
    await runtime.pty.close().catch(() => undefined);
    remotes.delete(instance.id);
    await runtime.endpoint.close().catch(() => undefined);
  }

  // ---- local target ---------------------------------------------------------

  async function awaitHealthy(instance: T3Instance, pid: number, port: number): Promise<void> {
    const watcher = { cancelled: false };
    watchers.add(watcher);
    const deadline = Date.now() + startTimeoutMs;
    try {
      while (!watcher.cancelled) {
        if (!isAlive(pid)) {
          instance.status = 'exited';
          instance.pid = null;
          instance.url = null;
          instance.endpoint = null;
          instance.statusReason = `t3 exited during startup — see ${logFileFor(instance.id)}`;
          changed();
          return;
        }
        if (await healthCheck(port)) {
          instance.status = 'running';
          instance.url = `http://127.0.0.1:${port}`;
          instance.endpoint = loopbackEndpoint(port, instance.url);
          instance.statusReason = null;
          changed();
          return;
        }
        if (Date.now() >= deadline) break;
        await sleep(pollIntervalMs);
      }
      if (watcher.cancelled) return;
      instance.status = 'unhealthy';
      instance.statusReason =
        `No HTTP response on port ${port} within ${Math.round(startTimeoutMs / 1000)}s — ` +
        `see ${logFileFor(instance.id)}`;
      changed();
    } finally {
      watchers.delete(watcher);
    }
  }

  async function startLocal(instance: T3Instance): Promise<T3Instance> {
    const profileEnv = validateProfiles(instance.profiles);
    const binary = resolveBinary('t3');
    if (!binary) {
      throw new ApiFailure(
        400,
        't3-not-found',
        'The `t3` binary was not found on PATH — install T3 Code or add it to PATH',
      );
    }

    const port = await findPort(portsInUse(instance.id, LOCAL_TARGET_ID));
    fs.mkdirSync(instance.baseDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(config.logsDir, { recursive: true, mode: 0o700 });
    const logFile = logFileFor(instance.id);

    // argv[0] is the binary itself; the local spawn takes it separately.
    const args = t3ServeArgv(binary, port, instance.baseDir).slice(1);
    const pid = spawnDetached({
      command: binary,
      args,
      env: { ...process.env, ...profileEnv },
      cwd: instance.baseDir,
      logFile,
    });
    if (pid === null) {
      instance.status = 'exited';
      instance.pid = null;
      instance.port = null;
      instance.url = null;
      instance.endpoint = null;
      instance.statusReason = `Could not spawn t3 — see ${logFile}`;
      changed();
      throw new ApiFailure(500, 'spawn-failed', instance.statusReason);
    }

    instance.status = 'starting';
    instance.pid = pid;
    instance.port = port;
    instance.url = null;
    instance.endpoint = loopbackEndpoint(port, null);
    instance.statusReason = null;
    changed();

    await awaitHealthy(instance, pid, port);
    return { ...instance };
  }

  async function stopLocal(instance: T3Instance): Promise<void> {
    const pid = instance.pid;
    if (pid === null || !isAlive(pid)) return;
    try {
      signal(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
    const deadline = Date.now() + stopTimeoutMs;
    while (isAlive(pid) && Date.now() < deadline) await sleep(pollIntervalMs);
    if (isAlive(pid)) {
      try {
        signal(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
      const hardDeadline = Date.now() + Math.min(2_000, stopTimeoutMs);
      while (isAlive(pid) && Date.now() < hardDeadline) await sleep(pollIntervalMs);
    }
  }

  return {
    list,

    async create(req: CreateT3InstanceRequest): Promise<T3Instance> {
      const targetId = req.targetId ?? LOCAL_TARGET_ID;
      const id = crypto.randomUUID();
      let baseDir: string;
      if (targetId === LOCAL_TARGET_ID) {
        validateProfiles(req.profiles);
        baseDir = path.join(config.t3Dir, id);
        fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 });
      } else {
        const transport = requireTransport(targetId);
        await resolveRemoteProfile(targetId, req.profiles);
        baseDir = await createRemoteBaseDir(transport, id);
      }
      const instance: T3Instance = {
        id,
        label: req.label,
        targetId,
        port: null,
        baseDir,
        profiles: { ...req.profiles },
        status: 'stopped',
        pid: null,
        url: null,
        endpoint: null,
        statusReason: null,
        createdAt: new Date().toISOString(),
      };
      instances.set(id, instance);
      changed();
      return { ...instance };
    },

    async start(id: string): Promise<T3Instance> {
      const instance = mustGet(id);
      if (instance.status === 'running' || instance.status === 'starting') {
        throw new ApiFailure(
          409,
          'already-running',
          `${instance.label} is already ${instance.status}`,
        );
      }
      return instance.targetId === LOCAL_TARGET_ID ? startLocal(instance) : startRemote(instance);
    },

    async stop(id: string): Promise<T3Instance> {
      const instance = mustGet(id);
      if (instance.targetId === LOCAL_TARGET_ID) {
        await stopLocal(instance);
      } else {
        await stopRemote(instance);
      }
      instance.status = 'stopped';
      instance.pid = null;
      instance.port = null; // a fresh port is assigned on the next start
      instance.url = null;
      instance.endpoint = null;
      instance.statusReason = null;
      changed();
      return { ...instance };
    },

    async remove(id: string): Promise<void> {
      const instance = mustGet(id);
      if (instance.status !== 'stopped') {
        throw new ApiFailure(
          400,
          'instance-not-stopped',
          `Stop ${instance.label} before removing it`,
        );
      }
      instances.delete(id);
      if (instance.targetId === LOCAL_TARGET_ID) {
        try {
          fs.rmSync(instance.baseDir, { recursive: true, force: true });
        } catch {
          /* leftover base dir is not worth failing the request */
        }
      }
      // A base dir on a remote target is left alone on purpose: deleting a
      // path this machine cannot see is not a risk worth taking.
      changed();
    },

    async adopt(): Promise<void> {
      let dirty = false;
      for (const instance of instances.values()) {
        if (instance.targetId !== LOCAL_TARGET_ID) {
          // A remote instance is supervised through its transport's pty and
          // endpoint, and neither outlives this process — so nothing is left
          // to adopt. Reporting it as stopped beats linking a dead endpoint.
          if (instance.status !== 'stopped' || instance.port !== null) {
            dirty = true;
            instance.status = 'stopped';
            instance.pid = null;
            instance.port = null;
            instance.url = null;
            instance.endpoint = null;
            instance.statusReason = null;
          }
          continue;
        }
        const pid = instance.pid;
        const healthy =
          pid !== null &&
          instance.port !== null &&
          isAlive(pid) &&
          (await healthCheck(instance.port));
        if (healthy && instance.port !== null) {
          if (instance.status !== 'running' || instance.url === null) dirty = true;
          instance.status = 'running';
          instance.url = `http://127.0.0.1:${instance.port}`;
          instance.endpoint = loopbackEndpoint(instance.port, instance.url);
          instance.statusReason = null;
        } else if (instance.status !== 'stopped' || instance.pid !== null) {
          dirty = true;
          instance.status = 'stopped';
          instance.pid = null;
          instance.port = null;
          instance.url = null;
          instance.endpoint = null;
          instance.statusReason = null;
        }
      }
      if (dirty) changed();
    },

    shutdown() {
      // Instances are detached on purpose: only stop watching them.
      for (const watcher of watchers) watcher.cancelled = true;
      watchers.clear();
      // Remote handles belong to the transport, which the daemon closes itself.
      remotes.clear();
    },
  };
}

/** argv for one managed instance — one place, so local and remote agree. */
export function t3ServeArgv(binary: string, port: number, baseDir: string): string[] {
  return [binary, 'serve', '--port', String(port), '--base-dir', baseDir];
}

/** The local target serves the instance itself, so its URL is its own loopback. */
function loopbackEndpoint(port: number, url: string | null): T3Endpoint {
  return { scope: 'loopback', protocol: 'http', port, url };
}

function describeExit(status: ExitStatus): string {
  if (status.signal) return `was killed by ${status.signal}`;
  return `exited with code ${status.exitCode ?? 'unknown'}`;
}

/** Lowest free TCP port at or above `from`, skipping ports we already handed out. */
export async function findFreePort(
  from: number,
  exclude: ReadonlySet<number> = new Set(),
  host = '127.0.0.1',
): Promise<number> {
  for (let port = from; port < from + PORT_SCAN_LIMIT; port++) {
    if (exclude.has(port)) continue;
    if (await portIsFree(port, host)) return port;
  }
  throw new ApiFailure(500, 'no-free-port', `No free port in ${from}..${from + PORT_SCAN_LIMIT}`);
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

function spawnDetachedProcess(req: T3SpawnRequest): number | null {
  const fd = fs.openSync(req.logFile, 'a');
  try {
    const child = spawn(req.command, req.args, {
      cwd: req.cwd,
      env: req.env,
      detached: true,
      stdio: ['ignore', fd, fd],
    });
    child.on('error', () => {
      /* reported through the health check + log file */
    });
    child.unref();
    return child.pid ?? null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd); // the child kept its own duplicated descriptor
  }
}

function findOnPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* next entry */
    }
  }
  return null;
}

function readStore(file: string): T3Instance[] {
  try {
    const parsed = storeFileSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (!parsed.success) return [];
    return parsed.data.instances as T3Instance[];
  } catch {
    return [];
  }
}

function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* nothing to clean up */
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait for `promise`, but no longer than `ms`; the timer is cleared either way. */
function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    void promise.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}
