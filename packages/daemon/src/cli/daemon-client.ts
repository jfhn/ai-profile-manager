/** Shared local-daemon client used by normal CLI commands and the SSH agent. */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ApiError } from '@apm/shared';
import { ensureDirs, readLiveRunFile, resolveConfig, type RunFileData } from '../config.js';
import { CliError } from './parse.js';
import { ApiRequestError } from './profile-add.js';

const DAEMON_START_TIMEOUT_MS = 15_000;

/** Return the live daemon, starting a detached one if there is none. */
export async function daemonOrStart(): Promise<RunFileData> {
  const config = resolveConfig();
  const live = readLiveRunFile(config);
  if (live) return live;

  ensureDirs(config);
  const entry = fileURLToPath(new URL('../main.js', import.meta.url));
  if (!fs.existsSync(entry)) {
    throw new CliError(`daemon entry point not found at ${entry} — build the daemon first`);
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
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new CliError(
    `daemon did not come up within ${DAEMON_START_TIMEOUT_MS / 1000}s — see ${logFile}`,
  );
}

/** Authenticated loopback request. Throws instead of exiting on failures. */
export async function apiRequest<T>(
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
