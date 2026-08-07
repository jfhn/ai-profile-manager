/**
 * apm subcommands — a thin HTTP/WebSocket client of the daemon.
 *
 * The daemon is found through the run file (<dataDir>/run/daemon.json); for
 * run/attach/sessions one is started on demand. Nothing here talks to the
 * session host directly, so a shell attach and a browser tab are two views of
 * the same session.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import WebSocket from 'ws';
import type {
  ApiError,
  OverviewResponse,
  StatusResponse,
  TerminalClientMessage,
  TerminalServerMessage,
  TerminalSession,
} from '@apm/shared';
import { ensureDirs, readLiveRunFile, resolveConfig, type RunFileData } from '../config.js';
import { CliError, parseRunArgv, resolveProfile } from './parse.js';

export { parseRunArgv, resolveProfile } from './parse.js';

/** Ctrl-] — detaches without touching the session, like telnet/tmux. */
const DETACH_KEY = 0x1d;
const DAEMON_START_TIMEOUT_MS = 15_000;
const DAEMON_STOP_TIMEOUT_MS = 10_000;

/** Local copy: importing main.ts here would be circular. */
function fail(message: string): never {
  console.error(`apm: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------- commands --

export async function runCommand(argv: string[]): Promise<void> {
  let invocation;
  try {
    invocation = parseRunArgv(argv);
  } catch (error: unknown) {
    fail(errorMessage(error));
  }

  const run = await daemonOrStart();
  const overview = await api<OverviewResponse>(run, 'GET', '/api/overview');

  let profile;
  try {
    profile = resolveProfile(overview.profiles, invocation.profile, invocation.app);
  } catch (error: unknown) {
    fail(errorMessage(error));
  }

  const session = await api<TerminalSession>(run, 'POST', '/api/sessions', {
    profileId: profile.id,
    app: invocation.app,
    args: invocation.args,
    cwd: process.cwd(),
    cols: terminalSize().cols,
    rows: terminalSize().rows,
  });

  await attachSession(run, session);
}

export async function attachCommand(argv: string[]): Promise<void> {
  const target = argv[0];
  if (target === undefined || target.startsWith('-')) fail('usage: apm attach <session>');

  const run = await daemonOrStart();
  const { sessions } = await api<{ sessions: TerminalSession[] }>(run, 'GET', '/api/sessions');
  const session = sessions.find((entry) => entry.name === target || entry.id === target);
  if (!session) {
    const names = sessions.map((entry) => entry.name).join(', ');
    fail(`no session "${target}"${names ? `\nsessions: ${names}` : ' (no sessions running)'}`);
  }

  await attachSession(run, session);
}

export async function sessionsCommand(_argv: string[]): Promise<void> {
  const run = await daemonOrStart();
  const overview = await api<OverviewResponse>(run, 'GET', '/api/overview');
  if (overview.sessions.length === 0) {
    console.log('no sessions');
    return;
  }

  const labels = new Map(overview.profiles.map((profile) => [profile.id, profile.label]));
  const rows = overview.sessions.map((session) => [
    session.name,
    labels.get(session.profileId) ?? session.profileId,
    [session.app, ...session.args].join(' '),
    session.status === 'exited' ? `exited(${session.exitCode ?? '?'})` : session.status,
    String(session.attachedClients),
    new Date(session.createdAt).toLocaleString(),
  ]);
  printTable(['NAME', 'PROFILE', 'COMMAND', 'STATUS', 'ATTACHED', 'CREATED'], rows);
}

export async function statusCommand(_argv: string[]): Promise<void> {
  const run = readLiveRunFile(resolveConfig());
  if (!run) {
    console.log('apm daemon: not running');
    return;
  }
  const status = await api<StatusResponse>(run, 'GET', '/api/status');
  console.log('apm daemon: running');
  // Note: never print run.url — it carries the auth token.
  console.log(`  url:      http://${run.host}:${run.port}/`);
  console.log(`  pid:      ${status.pid}`);
  console.log(`  version:  ${status.version}`);
  console.log(`  data dir: ${status.dataDir}`);
  console.log(`  started:  ${status.startedAt}`);
}

export async function stopCommand(_argv: string[]): Promise<void> {
  const run = readLiveRunFile(resolveConfig());
  if (!run) {
    console.log('apm daemon: not running');
    return;
  }
  try {
    process.kill(run.pid, 'SIGTERM');
  } catch {
    console.log('apm daemon: not running');
    return;
  }
  const deadline = Date.now() + DAEMON_STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!processAlive(run.pid)) {
      console.log(`apm daemon stopped (pid ${run.pid})`);
      return;
    }
    await sleep(200);
  }
  fail(`daemon (pid ${run.pid}) did not stop within ${DAEMON_STOP_TIMEOUT_MS / 1000}s`);
}

// ----------------------------------------------------------------- attach --

/**
 * Bridge the local terminal to a session's WebSocket until the session exits
 * or the user detaches with Ctrl-]. The terminal is always restored.
 */
async function attachSession(run: RunFileData, session: TerminalSession): Promise<void> {
  const stdin = process.stdin;
  const wasRaw = stdin.isTTY ? stdin.isRaw : false;
  const decoder = new StringDecoder('utf8');
  const url =
    `ws://${run.host}:${run.port}/ws/terminal/${encodeURIComponent(session.id)}` +
    `?token=${encodeURIComponent(run.token)}`;
  const ws = new WebSocket(url);

  let restored = false;
  let detaching = false;
  let exitCode: number | null = null;
  let exited = false;

  const onStdin = (chunk: Buffer): void => {
    const stop = chunk.indexOf(DETACH_KEY);
    if (stop === -1) {
      sendInput(decoder.write(chunk));
      return;
    }
    sendInput(decoder.write(chunk.subarray(0, stop)));
    detaching = true;
    ws.close();
  };

  const onResize = (): void => {
    send({
      type: 'resize',
      cols: positiveOr(process.stdout.columns, session.cols),
      rows: positiveOr(process.stdout.rows, session.rows),
    });
  };

  function send(message: TerminalClientMessage): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }

  function sendInput(data: string): void {
    if (data.length > 0) send({ type: 'input', data });
  }

  function restore(): void {
    if (restored) return;
    restored = true;
    process.off('SIGWINCH', onResize);
    stdin.off('data', onStdin);
    if (stdin.isTTY) stdin.setRawMode(wasRaw);
    stdin.pause();
  }

  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => {
      if (stdin.isTTY) stdin.setRawMode(true);
      stdin.resume();
      stdin.on('data', onStdin);
      process.on('SIGWINCH', onResize);
      onResize();
    });

    ws.on('message', (raw) => {
      let message: TerminalServerMessage;
      try {
        message = JSON.parse(raw.toString()) as TerminalServerMessage;
      } catch {
        return;
      }
      switch (message.type) {
        case 'scrollback':
        case 'data':
          process.stdout.write(message.data);
          break;
        case 'exit':
          exited = true;
          exitCode = message.exitCode;
          ws.close();
          break;
        case 'error':
          process.stderr.write(`\r\napm: ${message.message}\r\n`);
          break;
      }
    });

    ws.on('error', (error: Error) => {
      restore();
      reject(new CliError(`terminal connection failed: ${error.message}`));
    });

    ws.on('close', () => {
      restore();
      resolve();
    });
  }).catch((error: unknown) => {
    fail(errorMessage(error));
  });

  restore();

  if (exited) {
    process.stderr.write(`\r\n[apm] ${session.name} exited with code ${exitCode ?? 0}\r\n`);
    process.exitCode = exitCode ?? 0;
  } else if (detaching) {
    process.stdout.write(`\r\ndetached: ${session.name}\r\n`);
  } else {
    process.stderr.write(`\r\n[apm] connection to ${session.name} closed\r\n`);
    process.exitCode = 1;
  }
  // Safety net: fires only if something still holds the event loop open.
  setTimeout(() => process.exit(process.exitCode ?? 0), 2_000).unref();
}

// ------------------------------------------------------------- daemon glue --

/** Return the live daemon, starting a detached one if there is none. */
async function daemonOrStart(): Promise<RunFileData> {
  const config = resolveConfig();
  const live = readLiveRunFile(config);
  if (live) return live;

  ensureDirs(config);
  const entry = fileURLToPath(new URL('../main.js', import.meta.url));
  if (!fs.existsSync(entry)) {
    fail(`daemon entry point not found at ${entry} — build the daemon first`);
  }

  const logFile = path.join(config.logsDir, 'daemon.log');
  const log = fs.openSync(logFile, 'a');
  let pid: number | undefined;
  try {
    const child = spawn(process.execPath, [entry, '__daemon'], {
      detached: true,
      stdio: ['ignore', log, log],
    });
    child.on('error', () => {
      /* surfaced by the run-file timeout below */
    });
    child.unref();
    pid = child.pid;
  } finally {
    fs.closeSync(log);
  }

  const deadline = Date.now() + DAEMON_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const run = readLiveRunFile(config);
    if (run && (pid === undefined || run.pid === pid)) return run;
    await sleep(200);
  }
  fail(`daemon did not come up within ${DAEMON_START_TIMEOUT_MS / 1000}s — see ${logFile}`);
}

async function api<T>(
  run: RunFileData,
  method: string,
  endpoint: string,
  body?: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`http://${run.host}:${run.port}${endpoint}`, {
      method,
      headers: {
        authorization: `Bearer ${run.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error: unknown) {
    return fail(`cannot reach the daemon at ${run.host}:${run.port} (${errorMessage(error)})`);
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const apiError = payload as ApiError | null;
    return fail(apiError?.error?.message ?? `${method} ${endpoint} failed with ${response.status}`);
  }
  return payload as T;
}

// ------------------------------------------------------------------ output --

/** Terminal size with sane fallbacks — non-TTY stdio reports 0 or undefined. */
function terminalSize(): { cols: number; rows: number } {
  return {
    cols: positiveOr(process.stdout.columns, 80),
    rows: positiveOr(process.stdout.rows, 24),
  };
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 2 ? value : fallback;
}

function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? '').length)),
  );
  const line = (cells: string[]): string =>
    cells
      .map((cell, column) =>
        column === cells.length - 1 ? cell : cell.padEnd(widths[column] ?? cell.length),
      )
      .join('  ')
      .trimEnd();
  console.log(line(headers));
  for (const row of rows) console.log(line(row));
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
