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
import {
  LOCAL_TARGET_ID,
  profilesCliResponseSchema,
  targetProfilesCliResponseSchema,
  targetsCliProducerSchema,
  usageSnapshotSchema,
} from '@apm/shared';
import type {
  ApiError,
  CreateSessionRequest,
  OverviewResponse,
  Profile,
  ProfilesCliResponse,
  StatusResponse,
  TargetProfilesCliResponse,
  TargetProfilesResponse,
  TargetsCliResponse,
  TargetsResponse,
  TerminalClientMessage,
  TerminalServerMessage,
  TerminalSession,
} from '@apm/shared';
import { ensureDirs, readLiveRunFile, resolveConfig, type RunFileData } from '../config.js';
import { childProcessEnv } from '../process-env.js';
import { DetachEscapeParser } from './detach-escape.js';
import {
  CliError,
  parseProfileArgv,
  parseProfilesArgv,
  parseRunArgv,
  parseTargetsArgv,
  resolveProfile,
  type ProfileAdoptInvocation,
  type RunInvocation,
} from './parse.js';
import { ApiRequestError, runProfileAdd } from './profile-add.js';

const DAEMON_START_TIMEOUT_MS = 15_000;
const DAEMON_STOP_TIMEOUT_MS = 10_000;
const ESCAPE_SEQUENCE_TIMEOUT_MS = 30;
const LOCAL_TERMINAL_RESTORE =
  '\u001b[<u' + // pop enhanced keyboard reporting
  '\u001b[>4;0m' + // disable xterm modifyOtherKeys
  '\u001b[?2004l' + // disable bracketed paste
  '\u001b[?1004l' + // disable focus reporting
  '\u001b[?2026l' + // end synchronized output
  '\u001b[?25h' + // show cursor
  '\u001b[0 q'; // reset cursor shape

/** Local copy: importing main.ts here would be circular. */
function fail(message: string): never {
  console.error(`apm: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------- commands --

export async function profileCommand(argv: string[]): Promise<void> {
  let invocation;
  try {
    invocation = parseProfileArgv(argv);
  } catch (error: unknown) {
    fail(errorMessage(error));
  }

  const run = await daemonOrStart();
  try {
    switch (invocation.action) {
      case 'add':
        await runProfileAdd(
          {
            api: (method, endpoint, body) => apiRequest(run, method, endpoint, body),
            runLogin: (loginArgv, env) => runLoginProcess(loginArgv, env),
            log: (line) => console.log(line),
            sleep,
          },
          invocation,
        );
        return;
      case 'sync-enable':
        await runSyncEnable(run, invocation.profile);
        return;
      case 'adopt':
        await runAdopt(run, invocation);
        return;
    }
  } catch (error: unknown) {
    fail(errorMessage(error));
  }
}

/**
 * Prints exactly one JSON line: the adopt flow on another machine execs this
 * command over SSH and parses that line for the sync id.
 */
async function runSyncEnable(run: RunFileData, profileRef: string): Promise<void> {
  const overview = await apiRequest<OverviewResponse>(run, 'GET', '/api/overview');
  const profile = resolveProfile(overview.profiles, profileRef, '');
  const updated = await apiRequest<Profile>(
    run,
    'POST',
    `/api/profiles/${encodeURIComponent(profile.id)}/sync-enable`,
  );
  if (!updated.sync) throw new CliError('the daemon returned a profile without sync state');
  process.stdout.write(`${JSON.stringify({ syncId: updated.sync.id, role: updated.sync.role })}\n`);
}

async function runAdopt(run: RunFileData, invocation: ProfileAdoptInvocation): Promise<void> {
  const response = await apiRequest<TargetProfilesResponse>(
    run,
    'GET',
    `/api/targets/${encodeURIComponent(invocation.target)}/profiles`,
  );
  const remote = resolveProfile(response.profiles, invocation.remoteProfile, invocation.provider);
  const profile = await apiRequest<Profile>(
    run,
    'POST',
    `/api/targets/${encodeURIComponent(invocation.target)}/sync-adopt`,
    {
      provider: invocation.provider,
      remoteProfileId: remote.id,
      ...(invocation.label === undefined ? {} : { label: invocation.label }),
    },
  );
  console.log(
    `profile "${profile.label}" adopted from target "${invocation.target}" as a synced replica`,
  );
  console.log(`run it with: apm run ${profile.label} ${invocation.provider}`);
}

/**
 * Run the provider's login command in this terminal with the profile-home
 * env applied. The provider CLI owns the whole interaction (TTY prompts,
 * paste-a-code flows, device auth); we only wait for it to finish.
 */
function runLoginProcess(argv: string[], env: Record<string, string>): Promise<number> {
  const [command, ...args] = argv;
  if (command === undefined) throw new CliError('provider login command is empty');
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      env: childProcessEnv(env),
    });
    child.on('error', (error) => {
      reject(new CliError(`failed to start ${command}: ${error.message} — is it installed?`));
    });
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

export async function runCommand(argv: string[]): Promise<void> {
  let invocation;
  try {
    invocation = parseRunArgv(argv);
  } catch (error: unknown) {
    fail(errorMessage(error));
  }

  const run = await daemonOrStart();
  const overview = await api<OverviewResponse>(run, 'GET', '/api/overview');
  const candidates = invocation.target
    ? (
        await api<TargetProfilesResponse>(
          run,
          'GET',
          `/api/targets/${encodeURIComponent(invocation.target)}/profiles`,
        )
      ).profiles
    : overview.profiles;

  let profile;
  try {
    profile = resolveProfile(candidates, invocation.profile, invocation.app);
  } catch (error: unknown) {
    const target = invocation.target ? ` on target "${invocation.target}"` : '';
    fail(`${errorMessage(error)}${target}`);
  }

  const session = await api<TerminalSession>(
    run,
    'POST',
    '/api/sessions',
    buildRunSessionRequest(invocation, profile.id, terminalSize()),
  );

  try {
    await attachSession(run, session);
  } catch (error: unknown) {
    if (invocation.ephemeral) {
      await api<void>(run, 'DELETE', `/api/sessions/${encodeURIComponent(session.id)}`).catch(
        () => undefined,
      );
    }
    throw error;
  }
}

export function buildRunSessionRequest(
  invocation: RunInvocation,
  profileId: string,
  size: { cols: number; rows: number },
): CreateSessionRequest {
  return {
    ...(invocation.target === undefined ? {} : { targetId: invocation.target }),
    profileId,
    app: invocation.app,
    args: invocation.args,
    ...(invocation.cwd !== undefined
      ? { cwd: invocation.cwd }
      : invocation.target === undefined || invocation.target === LOCAL_TARGET_ID
        ? { cwd: process.cwd() }
        : {}),
    ...(invocation.ephemeral ? { lifecycle: 'connection-bound' } : {}),
    cols: size.cols,
    rows: size.rows,
  };
}

export function profilesContract(overview: OverviewResponse): ProfilesCliResponse {
  return profilesCliResponseSchema.parse({
    schemaVersion: 2,
    defaultProfileIds: { ...overview.defaultProfileIds },
    profiles: overview.profiles.map((profile) => {
      const usage = usageSnapshotSchema.safeParse(overview.usage[profile.id]);
      return {
        id: profile.id,
        provider: profile.provider,
        label: profile.label,
        home: profile.home,
        status: profile.status,
        enabled: profile.enabled,
        usage: usage.success && usage.data.profileId === profile.id ? usage.data : null,
      };
    }),
  });
}

export async function profilesCommand(argv: string[]): Promise<void> {
  let invocation;
  try {
    invocation = parseProfilesArgv(argv);
  } catch (error: unknown) {
    fail(errorMessage(error));
  }

  const run = await daemonOrStart();
  if (invocation.refresh) await api<void>(run, 'POST', '/api/usage/refresh');
  const overview = await api<OverviewResponse>(run, 'GET', '/api/overview');
  const contract = profilesContract(overview);

  if (invocation.json) {
    process.stdout.write(`${JSON.stringify(contract)}\n`);
    return;
  }
  if (contract.profiles.length === 0) {
    console.log('no profiles');
    return;
  }

  const rows = contract.profiles.map((profile) => [
    contract.defaultProfileIds[profile.provider] === profile.id ? '*' : '',
    profile.provider,
    profile.label,
    profile.enabled ? profile.status : 'disabled',
    profile.usage?.cacheStatus ?? 'not-collected',
    profile.home,
  ]);
  printTable(['DEFAULT', 'PROVIDER', 'LABEL', 'STATUS', 'USAGE', 'HOME'], rows);
}

export function targetsContract(response: TargetsResponse): TargetsCliResponse {
  return targetsCliProducerSchema.parse({
    schemaVersion: 1,
    targets: response.targets.map((target) => ({
      ...target,
      identity: { ...target.identity },
      capabilities: [...target.capabilities],
    })),
  });
}

export function targetProfilesContract(
  targetId: string,
  response: TargetProfilesResponse,
): TargetProfilesCliResponse {
  return targetProfilesCliResponseSchema.parse({
    schemaVersion: 2,
    targetId,
    profiles: response.profiles.map((profile) => ({ ...profile })),
  });
}

export async function targetsCommand(argv: string[]): Promise<void> {
  let invocation;
  try {
    invocation = parseTargetsArgv(argv);
  } catch (error: unknown) {
    fail(errorMessage(error));
  }

  const run = await daemonOrStart();
  if (invocation.profilesTarget !== undefined) {
    const response = await api<TargetProfilesResponse>(
      run,
      'GET',
      `/api/targets/${encodeURIComponent(invocation.profilesTarget)}/profiles`,
    );
    const contract = targetProfilesContract(invocation.profilesTarget, response);
    if (invocation.json) {
      process.stdout.write(`${JSON.stringify(contract)}\n`);
      return;
    }
    if (contract.profiles.length === 0) {
      console.log(`no profiles on target ${contract.targetId}`);
      return;
    }
    printTable(
      ['PROVIDER', 'LABEL', 'STATUS', 'ID'],
      contract.profiles.map((profile) => [
        profile.provider,
        profile.label,
        profile.enabled ? profile.status : 'disabled',
        profile.id,
      ]),
    );
    return;
  }

  const contract = targetsContract(await api<TargetsResponse>(run, 'GET', '/api/targets'));
  if (invocation.json) {
    process.stdout.write(`${JSON.stringify(contract)}\n`);
    return;
  }
  printTable(
    ['ID', 'LABEL', 'KIND', 'STATUS', 'CAPABILITIES'],
    contract.targets.map((target) => [
      target.id,
      target.label,
      target.kind,
      target.approved ? target.status : 'unapproved',
      target.capabilities.join(','),
    ]),
  );
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

  const table = sessionsTable(overview);
  printTable(table.headers, table.rows);
}

export function sessionsTable(overview: Pick<OverviewResponse, 'profiles' | 'sessions'>): {
  headers: string[];
  rows: string[][];
} {
  const labels = new Map(overview.profiles.map((profile) => [profile.id, profile.label]));
  const rows = overview.sessions.map((session) => [
    session.name,
    session.targetId,
    labels.get(session.profileId) ?? session.profileId,
    [session.app, ...session.args].join(' '),
    session.status === 'exited'
      ? `exited(${session.signal ?? session.exitCode ?? '?'})`
      : session.status,
    String(session.attachedClients),
    new Date(session.createdAt).toLocaleString(),
  ]);
  return {
    headers: ['NAME', 'TARGET', 'PROFILE', 'COMMAND', 'STATUS', 'ATTACHED', 'CREATED'],
    rows,
  };
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

/**
 * Print the authenticated dashboard URL and nothing else, so it can be piped
 * (`xdg-open "$(apm url)"`). This is the deliberate counterpart to `apm status`,
 * which keeps the token out of its output.
 */
export async function urlCommand(_argv: string[]): Promise<void> {
  const run = await daemonOrStart();
  console.log(run.url);
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
 * or the user detaches with Ctrl-]/Ctrl-5 (or Enter, then ~d). The terminal is
 * always restored.
 */
async function attachSession(run: RunFileData, session: TerminalSession): Promise<void> {
  const stdin = process.stdin;
  const wasRaw = stdin.isTTY ? stdin.isRaw : false;
  const decoder = new StringDecoder('utf8');
  const detachEscape = new DetachEscapeParser();
  const url =
    `ws://${run.host}:${run.port}/ws/terminal/${encodeURIComponent(session.id)}` +
    `?token=${encodeURIComponent(run.token)}`;
  const ws = new WebSocket(url);

  let restored = false;
  let detaching = false;
  let escapeSequenceTimer: ReturnType<typeof setTimeout> | undefined;
  let exitCode: number | null = null;
  let signal: string | null = null;
  let exited = false;

  const onStdin = (chunk: Buffer): void => {
    if (detaching) return;
    if (escapeSequenceTimer) {
      clearTimeout(escapeSequenceTimer);
      escapeSequenceTimer = undefined;
    }
    const result = detachEscape.write(chunk);
    sendInput(decoder.write(result.data));
    if (result.detach) {
      detaching = true;
      ws.close();
      return;
    }
    if (detachEscape.hasPendingControlSequence) {
      escapeSequenceTimer = setTimeout(() => {
        escapeSequenceTimer = undefined;
        if (!detaching) sendInput(decoder.write(detachEscape.flushPendingControlSequence()));
      }, ESCAPE_SEQUENCE_TIMEOUT_MS);
    }
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
    if (escapeSequenceTimer) {
      clearTimeout(escapeSequenceTimer);
      escapeSequenceTimer = undefined;
    }
    process.off('SIGWINCH', onResize);
    stdin.off('data', onStdin);
    if (stdin.isTTY) stdin.setRawMode(wasRaw);
    stdin.pause();
    if (process.stdout.isTTY) process.stdout.write(LOCAL_TERMINAL_RESTORE);
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
          signal = message.signal;
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
  });

  restore();

  if (exited) {
    if (signal) {
      process.stderr.write(`\r\n[apm] ${session.name} exited from signal ${signal}\r\n`);
      process.exitCode = 1;
    } else {
      process.stderr.write(`\r\n[apm] ${session.name} exited with code ${exitCode ?? 1}\r\n`);
      process.exitCode = exitCode ?? 1;
    }
  } else if (detaching) {
    process.stdout.write(`\r\ndetached: ${session.name}\r\n`);
  } else {
    process.stderr.write(
      `\r\n[apm] connection to ${session.name} closed; ` +
        `reattach with: apm attach ${session.name}\r\n`,
    );
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
  try {
    return await apiRequest(run, method, endpoint, body);
  } catch (error: unknown) {
    return fail(errorMessage(error));
  }
}

/** Like api(), but throws instead of exiting so callers can branch on failures. */
async function apiRequest<T>(
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
    throw new CliError(
      `cannot reach the daemon at ${run.host}:${run.port} (${errorMessage(error)})`,
    );
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
    throw new ApiRequestError(
      apiError?.error?.message ?? `${method} ${endpoint} failed with ${response.status}`,
      apiError?.error?.code ?? null,
    );
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
