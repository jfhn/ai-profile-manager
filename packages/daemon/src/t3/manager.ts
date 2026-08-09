/**
 * Managed T3 Code instances.
 *
 * Each instance is a detached `t3 serve --port <p> --base-dir <dir>` process
 * with the bound profiles' env — no PTY, supervised by port + health check.
 * Detached is deliberate: instances survive a daemon restart and are re-adopted
 * by `adopt()`, so `shutdown()` must never kill them.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import {
  PROVIDER_IDS,
  providerIdSchema,
  type CreateT3InstanceRequest,
  type ProviderId,
  type T3Instance,
} from '@apm/shared';
import type { DaemonConfig } from '../config.js';
import { ApiFailure, type EventBus, type ProfileService, type T3Manager } from '../context.js';
import { httpProbe, portIsFree } from '../targets/net.js';

/** First port tried for a new instance; T3's own default (4700) is left alone. */
export const T3_PORT_BASE = 4800;
const PORT_SCAN_LIMIT = 200;
const DEFAULT_START_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 500;

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
}

const instanceSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  port: z.number().int().nullable(),
  baseDir: z.string().min(1),
  profiles: z.record(providerIdSchema, z.string()),
  status: z.enum(['stopped', 'starting', 'running', 'unhealthy', 'exited']),
  pid: z.number().int().nullable(),
  url: z.string().nullable(),
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

  const storeFile = path.join(config.t3Dir, 'instances.json');
  const instances = new Map<string, T3Instance>();
  for (const instance of readStore(storeFile)) instances.set(instance.id, instance);
  /** Health loops still running; shutdown() cancels them without touching the processes. */
  const watchers = new Set<{ cancelled: boolean }>();

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

  function portsInUse(exceptId: string): Set<number> {
    const used = new Set<number>();
    for (const instance of instances.values()) {
      if (instance.id === exceptId) continue;
      if (instance.port !== null && instance.status !== 'stopped') used.add(instance.port);
    }
    return used;
  }

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
          instance.statusReason = `t3 exited during startup — see ${logFileFor(instance.id)}`;
          changed();
          return;
        }
        if (await healthCheck(port)) {
          instance.status = 'running';
          instance.url = `http://127.0.0.1:${port}`;
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

  return {
    list,

    async create(req: CreateT3InstanceRequest): Promise<T3Instance> {
      validateProfiles(req.profiles);
      const id = crypto.randomUUID();
      const baseDir = path.join(config.t3Dir, id);
      fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 });
      const instance: T3Instance = {
        id,
        label: req.label,
        port: null,
        baseDir,
        profiles: { ...req.profiles },
        status: 'stopped',
        pid: null,
        url: null,
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

      const profileEnv = validateProfiles(instance.profiles);
      const binary = resolveBinary('t3');
      if (!binary) {
        throw new ApiFailure(
          400,
          't3-not-found',
          'The `t3` binary was not found on PATH — install T3 Code or add it to PATH',
        );
      }

      const port = await findPort(portsInUse(id));
      fs.mkdirSync(instance.baseDir, { recursive: true, mode: 0o700 });
      fs.mkdirSync(config.logsDir, { recursive: true, mode: 0o700 });
      const logFile = logFileFor(id);

      const pid = spawnDetached({
        command: binary,
        args: ['serve', '--port', String(port), '--base-dir', instance.baseDir],
        env: { ...process.env, ...profileEnv },
        cwd: instance.baseDir,
        logFile,
      });
      if (pid === null) {
        instance.status = 'exited';
        instance.pid = null;
        instance.port = null;
        instance.url = null;
        instance.statusReason = `Could not spawn t3 — see ${logFile}`;
        changed();
        throw new ApiFailure(500, 'spawn-failed', instance.statusReason);
      }

      instance.status = 'starting';
      instance.pid = pid;
      instance.port = port;
      instance.url = null;
      instance.statusReason = null;
      changed();

      await awaitHealthy(instance, pid, port);
      return { ...instance };
    },

    async stop(id: string): Promise<T3Instance> {
      const instance = mustGet(id);
      const pid = instance.pid;
      if (pid !== null && isAlive(pid)) {
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
      instance.status = 'stopped';
      instance.pid = null;
      instance.port = null; // a fresh port is assigned on the next start
      instance.url = null;
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
      try {
        fs.rmSync(instance.baseDir, { recursive: true, force: true });
      } catch {
        /* leftover base dir is not worth failing the request */
      }
      changed();
    },

    async adopt(): Promise<void> {
      let dirty = false;
      for (const instance of instances.values()) {
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
          instance.statusReason = null;
        } else if (instance.status !== 'stopped' || instance.pid !== null) {
          dirty = true;
          instance.status = 'stopped';
          instance.pid = null;
          instance.port = null;
          instance.url = null;
          instance.statusReason = null;
        }
      }
      if (dirty) changed();
    },

    shutdown() {
      // Instances are detached on purpose: only stop watching them.
      for (const watcher of watchers) watcher.cancelled = true;
      watchers.clear();
    },
  };
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
