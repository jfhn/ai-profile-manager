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
