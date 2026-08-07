/**
 * Terminal sessions: PTY processes owned by the daemon, bound to one profile
 * at spawn time, rendered via xterm.js in the browser or attached from a
 * real terminal.
 */

export type SessionStatus = 'running' | 'exited';

export interface TerminalSession {
  id: string;
  /** Short human handle for `apm attach <name>`, e.g. "claude-work-1". */
  name: string;
  profileId: string;
  /** The command being run, e.g. "claude" or "bash". */
  app: string;
  args: string[];
  cwd: string;
  status: SessionStatus;
  /** Exit code once status === 'exited'. */
  exitCode: number | null;
  cols: number;
  rows: number;
  /** Number of currently attached clients (web + CLI). */
  attachedClients: number;
  createdAt: string;
  exitedAt: string | null;
}

/** Client -> server messages on the terminal WebSocket (JSON text frames). */
export type TerminalClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number };

/**
 * Server -> client messages. After the socket opens the server first sends
 * 'scrollback' (bounded replay), then live 'data' frames.
 */
export type TerminalServerMessage =
  | { type: 'scrollback'; data: string }
  | { type: 'data'; data: string }
  | { type: 'exit'; exitCode: number | null }
  | { type: 'error'; message: string };
