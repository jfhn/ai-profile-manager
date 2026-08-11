/**
 * Terminal WebSocket: GET /ws/terminal/:sessionId?token=<token>
 *
 * This is an arbitrary-code-execution surface, so the upgrade is gated on the
 * per-start token *and* a localhost Origin before any pty is touched (the
 * Fastify onRequest hook does not see upgrade requests).
 */
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { terminalClientMessageSchema, type TerminalServerMessage } from '@apm/shared';
import type { AppContext, SessionHost } from '../context.js';
import { originAllowed } from '../security.js';
import type { SessionHostInternals } from './host.js';

const TERMINAL_PATH = /^\/ws\/terminal\/([^/]+)$/;

export interface TerminalWsHandle {
  /** Stop upgrades and forcibly disconnect every attached terminal client. */
  close(): Promise<void>;
}

export function attachTerminalWs(server: Server, ctx: AppContext): TerminalWsHandle {
  const host = internals(ctx.sessions);
  const wss = new WebSocketServer({ noServer: true });

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const match = TERMINAL_PATH.exec(url.pathname);
    if (!match) return reject(socket, 404, 'not-found', 'No such WebSocket endpoint');

    if (!originAllowed(req.headers.origin)) {
      return reject(socket, 403, 'forbidden-origin', 'Cross-origin requests are not allowed');
    }
    if (url.searchParams.get('token') !== ctx.config.token) {
      return reject(socket, 401, 'unauthorized', 'Missing or invalid auth token');
    }

    const session = host.find(decodeURIComponent(match[1] ?? ''));
    const streams = session ? host.streams(session.id) : null;
    if (!session || !streams) {
      return reject(socket, 404, 'session-not-found', 'No such session');
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      // Snapshot + attach in one synchronous step so no chunk is lost or doubled.
      send(ws, { type: 'scrollback', data: streams.scrollback() });
      const current = streams.session();
      if (current.status === 'exited') {
        send(ws, { type: 'exit', exitCode: current.exitCode, signal: current.signal });
      }
      const detach = streams.attach({
        onData: (data) => send(ws, { type: 'data', data }),
        onError: (message) => send(ws, { type: 'error', message }),
        onExit: (status) => send(ws, { type: 'exit', ...status }),
      });

      ws.on('message', (raw) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString());
        } catch {
          return; // ignore malformed frames
        }
        const message = terminalClientMessageSchema.safeParse(parsed);
        if (!message.success) return;
        if (message.data.type === 'input') {
          streams.write(message.data.data);
          return;
        }
        try {
          ctx.sessions.resize(session.id, message.data.cols, message.data.rows);
        } catch {
          /* session vanished mid-resize */
        }
      });

      // Persistent sessions keep running. A connection-bound session treats
      // the final detach as its owner disappearing and signals the PTY.
      ws.on('close', detach);
      ws.on('error', detach);
    });
  };
  server.on('upgrade', onUpgrade);

  let closePromise: Promise<void> | null = null;
  return {
    close() {
      if (closePromise) return closePromise;
      server.off('upgrade', onUpgrade);
      for (const client of wss.clients) client.terminate();
      closePromise = new Promise<void>((resolve, rejectClose) => {
        wss.close((error) => (error ? rejectClose(error) : resolve()));
      });
      return closePromise;
    },
  };
}

function send(ws: WebSocket, message: TerminalServerMessage): void {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(message));
}

const STATUS_TEXT: Record<number, string> = {
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
};

function reject(socket: Duplex, status: number, code: string, message: string): void {
  const body = JSON.stringify({ error: { code, message } });
  socket.write(
    `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}\r\n` +
      'Content-Type: application/json\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      'Connection: close\r\n\r\n' +
      body,
  );
  socket.destroy();
}

/**
 * The AppContext seam exposes SessionHost, but the WebSocket needs the raw
 * streams the host keeps internally. createSessionHost always returns the
 * richer object; this narrows it back with a clear failure if it ever doesn't.
 */
function internals(sessions: SessionHost): SessionHostInternals {
  const candidate = sessions as SessionHostInternals;
  if (typeof candidate.streams !== 'function' || typeof candidate.find !== 'function') {
    throw new Error('session host does not expose terminal streams');
  }
  return candidate;
}
