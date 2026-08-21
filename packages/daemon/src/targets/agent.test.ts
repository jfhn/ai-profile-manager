/**
 * The remote agent's teardown guarantee, run as a real process.
 *
 * This is the layer the live failure came from: SSH drops, sshd SIGHUPs the
 * agent, and anything it spawned — a pty child is a session leader — carries
 * on holding its ports with nobody supervising it. The only honest way to
 * check that is to start a real agent, give it a real child, and kill it the
 * way sshd would.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeAgentMessage } from './protocol.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/**
 * A child that ignores SIGHUP, prints a grandchild's pid and sits there.
 *
 * The ignored disposition is inherited, so neither process can be cleaned up
 * by a hangup — which is the whole point. A server that traps SIGHUP (plenty
 * do, for config reload) is exactly what survived the dropped connection
 * live, and a child that dies on SIGHUP would pass this test with no teardown
 * at all, because the kernel hangs the terminal up on its own.
 */
const PTY_ARGV = ['sh', '-c', 'trap "" HUP; sleep 60 & echo $!; wait'];

const agents: ChildProcessWithoutNullStreams[] = [];
let dataDir: string | null = null;

afterEach(() => {
  for (const agent of agents) agent.kill('SIGKILL');
  agents.length = 0;
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  dataDir = null;
});

/**
 * Start a real agent over stdio, exactly as the SSH transport does. Several
 * agents may share one data dir — that is precisely what a reconnect is.
 */
function startAgent(inDataDir?: string): ChildProcessWithoutNullStreams {
  dataDir = inDataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'apm-agent-'));
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', path.join(HERE, 'test-support', 'agent-entry.ts')],
    {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, APM_DATA_DIR: dataDir },
    },
  );
  child.stderr.resume();
  agents.push(child);
  return child;
}

/** Resolve with the grandchild pid the pty printed. */
function grandchildPid(child: ChildProcessWithoutNullStreams): Promise<number> {
  return new Promise((resolve, reject) => {
    let buffered = '';
    const timer = setTimeout(() => reject(new Error(`no pty output: ${buffered}`)), 20_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffered += chunk;
      for (const line of buffered.split('\n')) {
        let message: { type?: string; data?: string };
        try {
          message = JSON.parse(line) as { type?: string; data?: string };
        } catch {
          continue;
        }
        const pid = message.type === 'data' ? /(\d+)/.exec(message.data ?? '')?.[1] : undefined;
        if (pid) {
          clearTimeout(timer);
          resolve(Number(pid));
          return;
        }
      }
    });
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitUntilGone(pid: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('target agent teardown', () => {
  it('kills what it spawned when sshd hangs it up', async () => {
    const child = startAgent();
    child.stdin.write(
      encodeAgentMessage({ type: 'pty', spec: { argv: PTY_ARGV, cols: 80, rows: 24 } }),
    );
    const grandchild = await grandchildPid(child);
    expect(alive(grandchild)).toBe(true);

    // Exactly what sshd does to a remote command when its channel goes away.
    child.kill('SIGHUP');

    await waitUntilGone(grandchild);
    expect(alive(grandchild)).toBe(false);
  }, 60_000);

  it('kills what it spawned when the request stream reaches EOF', async () => {
    const child = startAgent();
    child.stdin.write(
      encodeAgentMessage({ type: 'pty', spec: { argv: PTY_ARGV, cols: 80, rows: 24 } }),
    );
    const grandchild = await grandchildPid(child);
    expect(alive(grandchild)).toBe(true);

    // A dropped connection closes the agent's stdin without any signal.
    child.stdin.end();

    await waitUntilGone(grandchild);
    expect(alive(grandchild)).toBe(false);
  }, 60_000);
});

// ------------------------------------------------------------------- sync --

const SYNC_ID = '11111111-2222-4333-8444-555555555555';
const T1 = Date.parse('2026-08-20T10:00:00.000Z');
const T2 = Date.parse('2026-08-20T11:00:00.000Z');

/**
 * A data dir holding one synced claude profile whose home has credentials.
 * The store file's exact bytes are the read-only assertion: sync requests
 * must never rewrite it, not even as a no-op re-serialization.
 */
function writeSyncFixture(role: 'owner' | 'replica' = 'owner'): {
  dir: string;
  storeFile: string;
  credentialsFile: string;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-agent-sync-'));
  const home = path.join(dir, 'homes', 'claude-home');
  fs.mkdirSync(home, { recursive: true });
  const credentialsFile = path.join(home, '.credentials.json');
  fs.writeFileSync(
    credentialsFile,
    JSON.stringify({ claudeAiOauth: { accessToken: 'agent-token-1' }, unrelated: true }),
  );
  fs.utimesSync(credentialsFile, T1 / 1000, T1 / 1000);
  const storeFile = path.join(dir, 'profiles.json');
  fs.writeFileSync(
    storeFile,
    JSON.stringify({
      version: 2,
      profiles: [
        {
          id: 'profile-sync-1',
          provider: 'claude',
          label: 'work',
          home,
          homeKind: 'managed',
          identity: null,
          status: 'active',
          statusReason: null,
          enabled: true,
          sync: { id: SYNC_ID, role },
          createdAt: '2026-08-01T00:00:00.000Z',
        },
      ],
    }),
  );
  return { dir, storeFile, credentialsFile };
}

/** First JSON line the agent prints. */
function firstResponse(child: ChildProcessWithoutNullStreams): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buffered = '';
    const timer = setTimeout(() => reject(new Error(`no response: ${buffered}`)), 20_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffered += chunk;
      const line = buffered.split('\n').find((candidate) => candidate.trim().length > 0);
      if (line === undefined || !buffered.includes('\n')) return;
      clearTimeout(timer);
      try {
        resolve(JSON.parse(line) as Record<string, unknown>);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

function askAgent(dir: string, request: unknown): Promise<Record<string, unknown>> {
  const child = startAgent(dir);
  child.stdin.end(`${JSON.stringify(request)}\n`);
  return firstResponse(child);
}

describe('target agent credential sync', () => {
  it('serves sync-pull with the bundle and never rewrites the store file', async () => {
    const { dir, storeFile } = writeSyncFixture('owner');
    const storeBytes = fs.readFileSync(storeFile, 'utf8');

    const response = await askAgent(dir, { type: 'sync-pull', syncId: SYNC_ID, role: 'replica' });
    expect(response).toEqual({
      type: 'sync-bundle',
      bundle: {
        provider: 'claude',
        rotatedAt: new Date(T1).toISOString(),
        payload: { claudeAiOauth: { accessToken: 'agent-token-1' } },
      },
    });
    expect(fs.readFileSync(storeFile, 'utf8')).toBe(storeBytes);
  }, 60_000);

  it('answers sync-conflict when both sides claim owner and sync-not-enabled for unknown ids', async () => {
    const { dir } = writeSyncFixture('owner');
    expect(
      await askAgent(dir, { type: 'sync-pull', syncId: SYNC_ID, role: 'owner' }),
    ).toMatchObject({ type: 'error', code: 'sync-conflict' });
    expect(
      await askAgent(dir, {
        type: 'sync-pull',
        syncId: '99999999-9999-4999-8999-999999999999',
        role: 'replica',
      }),
    ).toMatchObject({ type: 'error', code: 'sync-not-enabled' });
  }, 60_000);

  it('applies a strictly newer push, rejects stale and provider-mismatched ones', async () => {
    const { dir, storeFile, credentialsFile } = writeSyncFixture('replica');
    const storeBytes = fs.readFileSync(storeFile, 'utf8');
    const bundle = (token: string, rotatedAtMs: number) => ({
      provider: 'claude',
      rotatedAt: new Date(rotatedAtMs).toISOString(),
      payload: { claudeAiOauth: { accessToken: token } },
    });

    const applied = await askAgent(dir, {
      type: 'sync-push',
      syncId: SYNC_ID,
      role: 'owner',
      bundle: bundle('agent-token-2', T2),
    });
    expect(applied).toEqual({ type: 'sync-applied', applied: true });
    const written = JSON.parse(fs.readFileSync(credentialsFile, 'utf8'));
    expect(written).toEqual({ claudeAiOauth: { accessToken: 'agent-token-2' }, unrelated: true });
    expect(Math.trunc(fs.statSync(credentialsFile).mtimeMs)).toBe(T2);

    const stale = await askAgent(dir, {
      type: 'sync-push',
      syncId: SYNC_ID,
      role: 'owner',
      bundle: bundle('agent-token-1', T1),
    });
    expect(stale).toEqual({ type: 'sync-applied', applied: false });

    const mismatched = await askAgent(dir, {
      type: 'sync-push',
      syncId: SYNC_ID,
      role: 'owner',
      bundle: {
        provider: 'codex',
        rotatedAt: new Date(T2).toISOString(),
        payload: { tokens: { access_token: 'x' } },
      },
    });
    expect(mismatched).toMatchObject({ type: 'error', code: 'sync-conflict' });
    expect(fs.readFileSync(storeFile, 'utf8')).toBe(storeBytes);
  }, 60_000);
});
