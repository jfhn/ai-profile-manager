/**
 * The local transport — the machine the daemon itself runs on.
 *
 * It is the default target everywhere and the reference implementation of the
 * transport contract: everything a remote transport has to do is done here
 * against real processes, real ptys and real loopback ports. Commands are
 * always spawned from argv with `shell: false`, so no caller-supplied string
 * can ever reach a shell. The one piece of generated shell code is the
 * provider-CLI shim at the bottom, written from adapter values only.
 */
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
  type ExecOptions,
  type ExecutionTarget,
  type ExitStatus,
  type ProfileEnv,
  type PtyHandle,
  type PtySpec,
  type TargetCapability,
  type TargetProfileSummary,
  type TargetSignal,
  type TargetStatus,
  type TargetTransport,
} from '@apm/shared';
import type { ProfileService } from '../context.js';
import { profileShimDirectory } from '../core/profilePaths.js';
import { childProcessEnv } from '../process-env.js';

const DEFAULT_TERM = 'xterm-256color';

export interface LocalTransportDeps {
  /** Profiles live on this machine; only their env is ever applied, never exported. */
  profiles: Pick<ProfileService, 'list' | 'envFor'>;
  /** Root for the generated provider-CLI shims (DaemonConfig.shimsDir). */
  shimsDir: string;
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
    const shimDirs: string[] = [];
    for (const profileId of spec.profileIds ?? []) {
      const binding = deps.profiles.envFor(profileId);
      Object.assign(profileEnv, binding.session);
      if (!binding.appOnly) continue;
      // The app-only vars rename roots every tool reads, so only the provider
      // CLI may see them. When it is the command itself they go straight into
      // its env; otherwise a shim ahead of it on PATH sets them for that one
      // exec and leaves the rest of the session alone.
      if (path.basename(command) === binding.appOnly.app) {
        Object.assign(profileEnv, binding.appOnly.env);
      } else {
        const shimDir = writeAppShim(
          profileShimDirectory(deps.shimsDir, profileId),
          binding.appOnly,
        );
        if (shimDir) shimDirs.push(shimDir);
      }
    }
    const env = childProcessEnv(profileEnv, spec.env);
    if (shimDirs.length > 0) {
      env.PATH = [...shimDirs, ...(env.PATH ? [env.PATH] : [])].join(path.delimiter);
    }

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
      // Nothing to disconnect: ptys belong to their callers.
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

/**
 * Regenerate the shim for one app-only binding and return the directory to
 * prepend to PATH, or null where shims do not work.
 *
 * The script is generated here, never by a caller: only the adapter's own app
 * name and variables are interpolated. It drops its own directory from PATH
 * before exec so the real executable is found instead of itself, and so
 * anything the CLI spawns is a normal process again.
 *
 * Windows has no equivalent single-file trick (a .cmd shim would break every
 * caller that expects the real executable), so an app-only binding is simply
 * not applied to other apps there.
 */
function writeAppShim(dir: string, appOnly: NonNullable<ProfileEnv['appOnly']>): string | null {
  if (process.platform === 'win32') return null;
  const file = path.join(dir, appOnly.app);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(temporary, shimScript(dir, appOnly));
  fs.chmodSync(temporary, 0o755);
  // Rename, so a shim a concurrent session is running is never rewritten
  // under the shell reading it.
  fs.renameSync(temporary, file);
  return dir;
}

function shimScript(dir: string, appOnly: NonNullable<ProfileEnv['appOnly']>): string {
  const exports = Object.entries(appOnly.env)
    .map(([key, value]) => `export ${key}=${shellQuote(value)}\n`)
    .join('');
  // set -f keeps a PATH entry containing a glob character from expanding.
  return `#!/bin/sh
# Generated by apm. Gives ${appOnly.app} its profile home without putting
# these variables into the whole session.
set -f
IFS=:
self=\${0%/*}
rest=
for entry in $PATH; do
  if [ "$entry" != "$self" ] && [ "$entry" != ${shellQuote(dir)} ]; then
    rest=\${rest:+$rest:}$entry
  fi
done
unset IFS
set +f
export PATH="$rest"
${exports}exec ${appOnly.app} "$@"
`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
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
