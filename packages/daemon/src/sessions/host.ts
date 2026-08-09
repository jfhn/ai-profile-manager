/**
 * PTY session host: spawns provider CLIs (or arbitrary commands) bound to one
 * profile's environment, keeps a bounded scrollback per session, and fans
 * output out to any number of attached clients (web + CLI).
 *
 * A session outlives every client: closing a socket only detaches. Exited
 * sessions stay listed until they are disposed explicitly.
 *
 * The pty is opened through the approved target registry. An omitted target
 * still resolves to the daemon's local transport.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LOCAL_TARGET_ID } from '@apm/shared';
import type {
  CreateSessionRequest,
  ExitStatus,
  ProviderId,
  PtyHandle,
  TargetTransport,
  TerminalSession,
} from '@apm/shared';
import type { DaemonConfig } from '../config.js';
import { ApiFailure, type EventBus, type ProfileService, type SessionHost } from '../context.js';
import { toApiFailure } from '../targets/errors.js';
import { createLocalTransport } from '../targets/local.js';
import { createTargetRegistry, type TargetRegistry } from '../targets/registry.js';

/** Scrollback kept per session; oldest whole chunks are dropped past this. */
export const DEFAULT_SCROLLBACK_BYTES = 1024 * 1024;
const RECENT_DIRS_LIMIT = 20;

/** Apps whose provider is known — the profile must match, or we refuse to spawn. */
const KNOWN_APPS: Record<string, ProviderId> = {
  claude: 'claude',
  codex: 'codex',
};

/** Live view of one session, used by the terminal WebSocket. */
export interface SessionListener {
  onData(data: string): void;
  onError(message: string): void;
  onExit(status: ExitStatus): void;
}

export interface SessionStreams {
  /** Bounded replay of everything the pty has written so far. */
  scrollback(): string;
  /** Current session record (status, exitCode, ...). */
  session(): TerminalSession;
  /** Forward client input to the pty (no-op once exited). */
  write(data: string): void;
  /**
   * Register a live listener and count the caller as an attached client.
   * Returns the detach function; detaching never kills the pty.
   */
  attach(listener: SessionListener): () => void;
}

/**
 * The concrete host. `streams` is deliberately not part of the SessionHost
 * seam in context.ts — only ws.ts needs it.
 */
export interface SessionHostInternals extends SessionHost {
  streams(id: string): SessionStreams | null;
  /** Look a session up by id or by its short name. */
  find(idOrName: string): TerminalSession | null;
}

export interface SessionHostOptions {
  /** Override the scrollback cap (tests). */
  scrollbackBytes?: number;
  /** Target the ptys are opened on; defaults to this machine. */
  transport?: TargetTransport;
  /** Approved target registry; production supplies the daemon-wide instance. */
  targets?: TargetRegistry;
}

interface SessionRecord {
  session: TerminalSession;
  pty: PtyHandle | null;
  chunks: string[];
  bytes: number;
  listeners: Set<SessionListener>;
}

export function createSessionHost(
  config: DaemonConfig,
  events: EventBus,
  profiles: ProfileService,
  options: SessionHostOptions = {},
): SessionHostInternals {
  const scrollbackBytes = options.scrollbackBytes ?? DEFAULT_SCROLLBACK_BYTES;
  const targets =
    options.targets ??
    createTargetRegistry(options.transport ?? createLocalTransport({ profiles }));
  const recentDirsFile = path.join(config.dataDir, 'recent-dirs.json');
  const sessions = new Map<string, SessionRecord>();
  const nameCounters = new Map<string, number>();
  let recentDirs = readRecentDirs(recentDirsFile);

  function list(): TerminalSession[] {
    return [...sessions.values()].map((record) => ({ ...record.session }));
  }

  function changed(): void {
    events.emit({ type: 'sessions-changed', sessions: list() });
  }

  function requireRecord(id: string): SessionRecord {
    const record = sessions.get(id);
    if (!record) throw new ApiFailure(404, 'session-not-found', `No session ${id}`);
    return record;
  }

  function nextName(app: string, profileLabel: string): string {
    const base = sanitize(`${path.basename(app)}-${profileLabel}`);
    const taken = new Set([...sessions.values()].map((record) => record.session.name));
    let n = nameCounters.get(base) ?? 0;
    let name: string;
    do {
      n += 1;
      name = `${base}-${n}`;
    } while (taken.has(name));
    nameCounters.set(base, n);
    return name;
  }

  function record(id: string, data: string): void {
    const entry = sessions.get(id);
    if (!entry) return;
    entry.chunks.push(data);
    entry.bytes += Buffer.byteLength(data);
    while (entry.bytes > scrollbackBytes && entry.chunks.length > 1) {
      const dropped = entry.chunks.shift();
      if (dropped === undefined) break;
      entry.bytes -= Buffer.byteLength(dropped);
    }
    for (const listener of entry.listeners) listener.onData(data);
  }

  function rememberDir(dir: string): void {
    recentDirs = [dir, ...recentDirs.filter((existing) => existing !== dir)].slice(
      0,
      RECENT_DIRS_LIMIT,
    );
    writeJsonAtomic(recentDirsFile, { version: 1, dirs: recentDirs });
  }

  return {
    list,

    find(idOrName) {
      const byId = sessions.get(idOrName);
      if (byId) return { ...byId.session };
      for (const entry of sessions.values()) {
        if (entry.session.name === idOrName) return { ...entry.session };
      }
      return null;
    },

    async create(req: CreateSessionRequest): Promise<TerminalSession> {
      let profile;
      let transport: TargetTransport;
      try {
        transport = targets.transportFor(req.targetId);
        profile = await targets.resolveProfile(req.targetId, req.profileId);
      } catch (error: unknown) {
        throw toApiFailure(error);
      }
      if (!profile.enabled) {
        throw new ApiFailure(409, 'profile-disabled', `Profile ${profile.label} is disabled`);
      }
      if (profile.status !== 'active') {
        throw new ApiFailure(
          409,
          'profile-not-active',
          `Profile ${profile.label} is ${profile.status}, not active`,
        );
      }

      const app = req.app;
      const requiredProvider = KNOWN_APPS[app];
      if (requiredProvider && profile.provider !== requiredProvider) {
        throw new ApiFailure(
          409,
          'provider-mismatch',
          `${app} needs a ${requiredProvider} profile, but ${profile.label} is ${profile.provider}`,
        );
      }

      const cwd = req.cwd ?? (transport.target.id === LOCAL_TARGET_ID ? os.homedir() : '~');
      const args = req.args ?? [];
      const cols = req.cols ?? 80;
      const rows = req.rows ?? 24;

      // The transport validates cwd and the executable on the target machine
      // and reports both as transport errors; the API codes are unchanged.
      let pty: PtyHandle;
      try {
        pty = await transport.openPty({
          argv: [app, ...args],
          cwd: req.cwd,
          cols,
          rows,
          profileId: profile.id,
        });
      } catch (error: unknown) {
        throw toApiFailure(error);
      }

      const id = crypto.randomUUID();
      const session: TerminalSession = {
        id,
        name: nextName(app, profile.label),
        targetId: transport.target.id,
        profileId: profile.id,
        app,
        args,
        cwd,
        status: 'running',
        exitCode: null,
        signal: null,
        cols,
        rows,
        attachedClients: 0,
        createdAt: new Date().toISOString(),
        exitedAt: null,
      };
      sessions.set(id, { session, pty, chunks: [], bytes: 0, listeners: new Set() });

      pty.onData((data) => record(id, data));
      pty.onError((error) => {
        const entry = sessions.get(id);
        if (!entry) return;
        for (const listener of entry.listeners) listener.onError(error.message);
      });
      pty.onExit((status) => {
        const entry = sessions.get(id);
        if (!entry) return;
        entry.pty = null;
        entry.session.status = 'exited';
        entry.session.exitCode = status.exitCode;
        entry.session.signal = status.signal;
        entry.session.exitedAt = new Date().toISOString();
        for (const listener of entry.listeners) listener.onExit(status);
        changed();
      });

      if (transport.target.id === LOCAL_TARGET_ID) rememberDir(cwd);
      changed();
      return { ...session };
    },

    kill(id) {
      const entry = requireRecord(id);
      // SIGHUP, as node-pty's own kill() default was.
      entry.pty?.signal('SIGHUP');
    },

    dispose(id) {
      const entry = requireRecord(id);
      if (entry.session.status !== 'exited') {
        throw new ApiFailure(
          400,
          'session-running',
          `Session ${entry.session.name} is still running`,
        );
      }
      sessions.delete(id);
      changed();
    },

    resize(id, cols, rows) {
      const entry = requireRecord(id);
      entry.session.cols = cols;
      entry.session.rows = rows;
      // A pty that is already gone ignores the resize; the recorded size is
      // still useful for reattach.
      entry.pty?.resize(cols, rows);
    },

    shutdown() {
      for (const entry of sessions.values()) {
        void entry.pty?.close().catch(() => undefined);
      }
    },

    recentDirs() {
      return recentDirs.length > 0 ? [...recentDirs] : [os.homedir()];
    },

    streams(id) {
      const entry = sessions.get(id);
      if (!entry) return null;
      return {
        scrollback: () => entry.chunks.join(''),
        session: () => ({ ...entry.session }),
        write: (data) => entry.pty?.write(data),
        attach(listener) {
          entry.listeners.add(listener);
          entry.session.attachedClients = entry.listeners.size;
          changed();
          let detached = false;
          return () => {
            if (detached) return;
            detached = true;
            entry.listeners.delete(listener);
            entry.session.attachedClients = entry.listeners.size;
            changed();
          };
        },
      };
    },
  };
}

function sanitize(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'session';
}

function readRecentDirs(file: string): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { dirs?: unknown };
    if (!Array.isArray(parsed.dirs)) return [];
    return parsed.dirs
      .filter((dir): dir is string => typeof dir === 'string')
      .slice(0, RECENT_DIRS_LIMIT);
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
