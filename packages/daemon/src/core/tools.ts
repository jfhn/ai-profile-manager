import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { CliToolStatus, ProviderId, UpdateCliToolResponse } from '@apm/shared';
import { ApiFailure, type CliToolService } from '../context.js';

interface CliToolSpec {
  provider: ProviderId;
  label: string;
  command: string;
}

type ProcessResult =
  | { state: 'exited'; code: number | null; stdout: string; stderr: string }
  | { state: 'failed'; error: string }
  | { state: 'timed-out'; timeoutMs: number; stdout: string; stderr: string };

const TOOL_SPECS: Record<ProviderId, CliToolSpec> = {
  claude: {
    provider: 'claude',
    label: 'Claude Code',
    command: 'claude',
  },
  codex: {
    provider: 'codex',
    label: 'Codex',
    command: 'codex',
  },
  cursor: {
    provider: 'cursor',
    label: 'Cursor Agent',
    command: 'cursor-agent',
  },
};

const VERSION_TIMEOUT_MS = 10_000;
const UPDATE_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_CHARS = 32_000;
const ANSI_CSI = new RegExp(`${String.fromCodePoint(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');

export function createCliToolService(
  sourceEnv: NodeJS.ProcessEnv = process.env,
  excludedPathDirs: readonly string[] = [],
): CliToolService {
  const env = { ...sourceEnv };
  // CLI installations belong to the machine. A daemon started from an apm-bound
  // shell may inherit a profile home, but an updater must never use it.
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_HOME;
  delete env.CURSOR_CONFIG_DIR;
  delete env.AGENT_CLI_CREDENTIAL_STORE;
  const excluded = new Set(excludedPathDirs.map((directory) => path.resolve(directory)));
  if (env.PATH) {
    env.PATH = env.PATH.split(path.delimiter)
      .filter((directory) => !excluded.has(path.resolve(directory)))
      .join(path.delimiter);
  }
  let updating: ProviderId | null = null;

  async function status(spec: CliToolSpec): Promise<CliToolStatus> {
    const base = { provider: spec.provider, label: spec.label };
    const executable = resolveExecutable(spec.command, env);
    if (!executable) return { ...base, state: 'missing' };

    const result = await runProcess(executable, ['--version'], env, VERSION_TIMEOUT_MS);
    if (result.state !== 'exited' || result.code !== 0) {
      return {
        ...base,
        state: 'error',
        executable,
        error: processFailure(`${spec.label} version check`, result),
      };
    }
    const version = cleanOutput(result.stdout || result.stderr)
      .split('\n')[0]
      ?.trim();
    if (!version) {
      return { ...base, state: 'error', executable, error: `${spec.label} returned no version.` };
    }
    return { ...base, state: 'installed', executable, version };
  }

  return {
    list: () => Promise.all(Object.values(TOOL_SPECS).map(status)),

    async update(provider): Promise<UpdateCliToolResponse> {
      const spec = TOOL_SPECS[provider];
      if (updating !== null) {
        throw new ApiFailure(409, 'tool-update-busy', `${TOOL_SPECS[updating].label} is updating.`);
      }
      updating = provider;
      try {
        const before = await status(spec);
        if (before.state === 'missing') {
          throw new ApiFailure(404, 'tool-not-installed', `${spec.label} is not installed.`);
        }
        if (before.state === 'error') {
          throw new ApiFailure(409, 'tool-unavailable', before.error);
        }

        const result = await runProcess(before.executable, ['update'], env, UPDATE_TIMEOUT_MS);
        if (result.state !== 'exited' || result.code !== 0) {
          throw new ApiFailure(
            500,
            'tool-update-failed',
            processFailure(`${spec.label} update`, result),
          );
        }
        const after = await status(spec);
        if (after.state !== 'installed') {
          throw new ApiFailure(
            500,
            'tool-update-failed',
            `${spec.label} update could not be verified.`,
          );
        }
        return {
          previousVersion: before.version,
          tool: after,
        };
      } finally {
        updating = null;
      }
    },
  };
}

function resolveExecutable(command: string, env: NodeJS.ProcessEnv): string | null {
  const pathValue = env.PATH;
  if (!pathValue) return null;
  const extensions =
    process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension.toLowerCase()}`);
      try {
        if (fs.statSync(candidate).isFile()) {
          fs.accessSync(candidate, fs.constants.X_OK);
          return candidate;
        }
      } catch {
        continue;
      }
    }
  }
  return null;
}

function runProcess(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const grouped = process.platform !== 'win32';
    const child = spawn(executable, [...args], {
      env,
      detached: grouped,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let forceKill: ReturnType<typeof setTimeout> | null = null;

    const kill = (signal: NodeJS.Signals): void => {
      try {
        if (grouped && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        return;
      }
    };

    child.stdout.on('data', (chunk: Buffer) => (stdout = appendOutput(stdout, chunk)));
    child.stderr.on('data', (chunk: Buffer) => (stderr = appendOutput(stderr, chunk)));

    const timeout = setTimeout(() => {
      timedOut = true;
      kill('SIGTERM');
      forceKill = setTimeout(() => kill('SIGKILL'), 2_000);
      forceKill.unref();
    }, timeoutMs);
    timeout.unref();

    const finish = (result: ProcessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKill && !timedOut) clearTimeout(forceKill);
      resolve(result);
    };

    child.on('error', (error) => finish({ state: 'failed', error: error.message }));
    child.on('close', (code) =>
      finish(
        timedOut
          ? { state: 'timed-out', timeoutMs, stdout, stderr }
          : { state: 'exited', code, stdout, stderr },
      ),
    );
  });
}

function appendOutput(current: string, chunk: Buffer): string {
  return `${current}${chunk.toString('utf8')}`.slice(-MAX_OUTPUT_CHARS);
}

function cleanOutput(value: string): string {
  return value.replace(ANSI_CSI, '').trim();
}

function processFailure(action: string, result: ProcessResult): string {
  if (result.state === 'failed') return `${action} failed: ${result.error}.`;
  if (result.state === 'timed-out') {
    return `${action} timed out after ${Math.ceil(result.timeoutMs / 1000)} seconds.`;
  }
  const detail = cleanOutput(result.stderr || result.stdout)
    .split('\n')
    .filter(Boolean)
    .at(-1)
    ?.slice(-240)
    .replace(/[.!?]+$/, '');
  return detail
    ? `${action} failed with exit code ${result.code ?? 'unknown'}: ${detail}.`
    : `${action} failed with exit code ${result.code ?? 'unknown'}.`;
}
