/**
 * Managed T3 Code instances, local or on a remote execution target.
 *
 * Local instances are a detached `t3 serve --port <p> --base-dir <dir>` process
 * with the bound profiles' env — no PTY, supervised by port + health check.
 * Detached is deliberate: instances survive a daemon restart and are re-adopted
 * by `adopt()`, so `shutdown()` must never kill them. Nothing about that path
 * changed when targets arrived.
 *
 * Remote instances mirror that model through the target's transport and
 * nothing else (no second SSH/Tailscale path): `spawnDetached` launches
 * `t3 serve` in its own session *on the target* from argv with the bound
 * profiles' *ids* — the target injects each profile's provider env, so no
 * credential ever reaches this machine — records it target-side, and
 * `openEndpoint` publishes the port and answers the health checks. Both the
 * process and its published endpoint deliberately survive a daemon restart;
 * `adopt()` re-links them (or reports the instance stopped with the reason)
 * and `stop()` is what actually terminates and unpublishes them, verified by
 * the target's own record. The endpoint is also the only source of the Open
 * link: a remote instance is behind a forward or the target's own address,
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
  profileIdSchema,
  providerIdSchema,
  type CreateT3InstanceRequest,
  type DetachedServiceInspection,
  type DetachedServiceState,
  type EndpointHandle,
  type EndpointHealth,
  type ProviderId,
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
import { APM_MANAGED_T3_INSTANCE_ENV } from './identity.js';

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
/** A remote instance needs all three: run detached, publish, resolve profiles. */
const REMOTE_CAPABILITIES: TargetCapability[] = ['detached', 'endpoint', 'profiles'];

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

/**
 * Live daemon-side handle for one remote instance. Deliberately not persisted:
 * the process itself is recorded *on the target*, and after a restart adopt()
 * rebuilds this from that record.
 */
interface RemoteRuntime {
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
  profiles: z.record(providerIdSchema, profileIdSchema),
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
   * Up to one bound profile per provider on a remote instance, mirroring the
   * local `validateProfiles` — but against the profiles the *target* reports,
   * because their ids mean nothing here. Only those opaque ids ever cross the
   * seam: the target resolves each one to its provider env locally, which is
   * exactly what keeps credentials from moving between machines.
   */
  async function resolveRemoteProfiles(
    targetId: TargetId,
    bound: Partial<Record<ProviderId, string>>,
  ): Promise<string[]> {
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
    for (const entry of entries) {
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
    }
    return entries.map((entry) => entry.profileId);
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

  /**
   * True while `runtime` is the one this instance is actually being served by.
   * A superseded runtime — start() after a failed start, say — still emits its
   * own exit and close events later, and those must not touch the instance the
   * *current* runtime owns.
   */
  function isCurrent(id: string, runtime: RemoteRuntime): boolean {
    return remotes.get(id) === runtime && !runtime.stopping;
  }

  /** Detach a remote instance's handles without claiming anything about status. */
  function releaseRemote(id: string): void {
    const runtime = remotes.get(id);
    if (!runtime) return;
    remotes.delete(id);
    void runtime.endpoint.close().catch(() => undefined);
  }

  /**
   * Tear down a runtime that is being replaced: only the daemon-side handle
   * and its published endpoint go. A process left on the target is the start
   * path's business — it stops it through the target's own record. Nothing
   * about the instance is touched: the caller is starting it again and owns
   * its status.
   */
  async function discardRemote(id: string): Promise<void> {
    const runtime = remotes.get(id);
    if (!runtime) return;
    // `stopping` silences its late events even for a listener that captured
    // the runtime before it was replaced.
    runtime.stopping = true;
    remotes.delete(id);
    await runtime.endpoint.close().catch(() => undefined);
  }

  function onEndpointClosed(id: string, runtime: RemoteRuntime, reason: string | null): void {
    const instance = instances.get(id);
    if (!instance || !isCurrent(id, runtime)) return;
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
    const profileIds = await resolveRemoteProfiles(targetId, instance.profiles);

    // A process from an earlier daemon may still hold the base dir — that is
    // the whole point of detaching. Starting is the user's explicit ask, so
    // the leftover is stopped first (verified by the target's own record);
    // adopt() is the path that never relaunches anything on its own.
    try {
      await transport.stopDetached(instance.id, instance.baseDir);
    } catch (error: unknown) {
      throw toApiFailure(error);
    }

    // Opened before the spawn: the target allocates the port, which is
    // per-target by construction, and the request has to name that port on
    // the command line.
    let endpoint: EndpointHandle;
    try {
      endpoint = await transport.openEndpoint({
        port: null,
        healthPath: '/',
        label: `t3 ${instance.label}`,
        // The endpoint outlives this daemon exactly like the service behind it.
        persistent: true,
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

    let state: DetachedServiceState;
    try {
      state = await transport.spawnDetached({
        argv: t3ServeArgv(REMOTE_T3_BINARY, port, instance.baseDir),
        cwd: instance.baseDir,
        // Non-secret target-local attribution for `apm pair`. The CLI requires
        // this id to agree with the managed base-dir child before minting.
        env: { [APM_MANAGED_T3_INSTANCE_ENV]: instance.id },
        // The target resolves each id to its own provider env locally.
        profileIds,
        instanceId: instance.id,
        port,
        baseDir: instance.baseDir,
      });
    } catch (error: unknown) {
      await endpoint.close();
      throw toApiFailure(error);
    }
    // t3's startup output carries a one-time pairing token, so the target
    // spawns it with its output discarded — there is nothing to read here.

    const runtime: RemoteRuntime = { endpoint, stopping: false };
    remotes.set(instance.id, runtime);
    endpoint.onClose((reason) => onEndpointClosed(instance.id, runtime, reason));

    instance.status = 'starting';
    instance.pid = state.pid;
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
    // The instance may have been stopped (or the daemon shut down) while we
    // waited.
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
      // Nothing answered. One look at the target's record tells a process
      // that died — almost always a failure to bind — from one that is
      // merely slow; "no HTTP response" is a useless thing to show for that.
      let inspection: DetachedServiceInspection | null = null;
      try {
        inspection = await transport.inspectDetached(instance.id, instance.baseDir);
      } catch {
        /* keep the health verdict when the record cannot be read */
      }
      if (inspection !== null && inspection.state === null) {
        releaseRemote(instance.id);
        instance.status = 'exited';
        instance.pid = null;
        instance.url = null;
        instance.endpoint = null;
        // Only the target's record and the port — never t3's output, which
        // can contain its pairing token.
        instance.statusReason =
          `t3 exited during startup on target "${targetId}" — port ${port} is most likely ` +
          'still held over there by an earlier instance. Start it again to take the next ' +
          'free port, or stop that process on the target.';
      } else {
        instance.status = 'unhealthy';
        instance.statusReason =
          health.reason ??
          `No HTTP response from t3 on target "${targetId}" within ` +
            `${Math.round(startTimeoutMs / 1000)}s`;
      }
    }
    changed();
    return { ...instance };
  }

  /**
   * Stop the detached process by the *target's* record — which is what makes
   * this work for a process spawned by a previous daemon or agent invocation,
   * not just the one this runtime knows. The target verifies the recorded pid
   * still is that process before killing (SIGTERM, then SIGKILL, delivered to
   * its process group), so a recycled pid is never signalled.
   */
  async function stopRemote(instance: T3Instance): Promise<void> {
    const runtime = remotes.get(instance.id) ?? null;
    // Nothing recorded and nothing linked: nothing worth reaching out for.
    if (instance.status === 'stopped' && runtime === null) return;
    if (runtime) runtime.stopping = true;
    let transport: TargetTransport | null = null;
    try {
      transport = requireTransport(instance.targetId);
    } catch {
      // A revoked or vanished target cannot be reached to kill anything; all
      // that is left is to let go of the instance here. Whatever still runs
      // over there is cleaned up on the target (see docs/T3-REMOTE.md).
    }
    if (transport) {
      try {
        await transport.stopDetached(instance.id, instance.baseDir);
      } catch (error: unknown) {
        // The process could not be terminated — an unreachable target, say.
        // Claiming "stopped" now would leave a server running with nobody
        // supervising it, so the failure is the honest answer.
        if (runtime) runtime.stopping = false;
        throw toApiFailure(error);
      }
    }
    remotes.delete(instance.id);
    if (runtime) await runtime.endpoint.close().catch(() => undefined);
  }

  /**
   * Re-link one remote instance after a daemon restart. The detached process
   * and its published endpoint kept running while apm was away; the target's
   * record says whether they still do. An instance that died in the meantime
   * is reported stopped with the reason — never relaunched from here.
   * Returns whether the instance was changed.
   */
  async function adoptRemote(instance: T3Instance): Promise<boolean> {
    const wasLive =
      instance.status === 'starting' ||
      instance.status === 'running' ||
      instance.status === 'unhealthy';
    if (!wasLive) {
      // 'stopped' and 'exited' were settled before the restart; only a stale
      // link is cleared, because no endpoint handle backs it any more... yet
      // the target-side state (if any) stays for stop()/start() to find.
      if (instance.url === null && instance.endpoint === null) return false;
      instance.url = null;
      instance.endpoint = null;
      return true;
    }

    const abandon = (statusReason: string): true => {
      instance.status = 'stopped';
      instance.pid = null;
      instance.port = null;
      instance.url = null;
      instance.endpoint = null;
      instance.statusReason = statusReason;
      return true;
    };

    let transport: TargetTransport;
    let inspection: DetachedServiceInspection;
    try {
      transport = requireTransport(instance.targetId);
      inspection = await transport.inspectDetached(instance.id, instance.baseDir);
    } catch (error: unknown) {
      // Unreachable target, an agent too old for the verbs, a revoked
      // registration — all degrade the same way: a clear reason and a stopped
      // instance, never a crash and never a dead link presented as live.
      return abandon(
        `Could not re-adopt this instance after the apm restart: ${describeError(error)}. ` +
          `If t3 is still running on "${instance.targetId}", stop it there or press Start ` +
          'to replace it.',
      );
    }
    const state = inspection.state;
    if (state === null) {
      // Died while the manager was away. Reported, not silently relaunched.
      return abandon(
        `t3 stopped on target "${instance.targetId}" while apm was down` +
          (inspection.reason ? ` (${inspection.reason})` : '') +
          ' — start it again when you want it back',
      );
    }

    // Still alive: re-publish the endpoint (idempotent on the target — an
    // existing serve entry for the port is reused) and re-read its URL.
    let endpoint: EndpointHandle;
    try {
      endpoint = await transport.openEndpoint({
        port: state.port,
        healthPath: '/',
        label: `t3 ${instance.label}`,
        persistent: true,
      });
    } catch (error: unknown) {
      instance.status = 'unhealthy';
      instance.pid = state.pid;
      instance.port = state.port;
      instance.url = null;
      instance.endpoint = null;
      instance.statusReason =
        `t3 is still running on target "${instance.targetId}", but its endpoint could not ` +
        `be re-published: ${describeError(error)}`;
      return true;
    }
    const runtime: RemoteRuntime = { endpoint, stopping: false };
    remotes.set(instance.id, runtime);
    endpoint.onClose((reason) => onEndpointClosed(instance.id, runtime, reason));

    instance.pid = state.pid;
    instance.port = state.port;
    const health = await endpoint.waitUntilHealthy(startTimeoutMs);
    if (remotes.get(instance.id) !== runtime) return true;
    if (health.state === 'healthy' && endpoint.endpoint.url !== null) {
      instance.status = 'running';
      instance.endpoint = snapshotEndpoint(endpoint);
      instance.url = instance.endpoint.url;
      instance.statusReason = null;
    } else if (health.state !== 'closed') {
      // onClose owns the 'closed' case; anything else is an honest unhealthy.
      instance.status = 'unhealthy';
      instance.endpoint = snapshotEndpoint(endpoint);
      instance.url = null;
      instance.statusReason =
        health.reason ??
        `t3 is running on target "${instance.targetId}" but did not answer over its endpoint`;
    }
    return true;
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
        await resolveRemoteProfiles(targetId, req.profiles);
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
      if (instance.targetId === LOCAL_TARGET_ID) return startLocal(instance);
      // An instance can be restarted while an earlier attempt's endpoint is
      // still published on the target — 'unhealthy' and 'exited' are both
      // startable. Retire that runtime before opening another one, or it
      // leaks over there and its late events land on the new one. (The old
      // *process*, if any, is stopped inside startRemote by its record.)
      await discardRemote(instance.id);
      return startRemote(instance);
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
          // Detached on the target, so it survived the restart on purpose —
          // re-link it from the target's record, or report why not.
          if (await adoptRemote(instance)) dirty = true;
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

    async shutdown(): Promise<void> {
      // Instances are detached on purpose — local and remote alike: only stop
      // watching them. A remote instance's process *and* its published
      // endpoint stay up on the target while the daemon is away (its handles
      // are opened persistent, so closing the transports leaves the serve
      // entry alone); adopt() re-links both on the way back up, and stop() is
      // what terminates the process and withdraws the endpoint.
      for (const watcher of watchers) watcher.cancelled = true;
      watchers.clear();
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

/** Message of an ApiFailure/TransportError/Error, for a statusReason. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
