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
/** Pids of detached services the tests spawned, reaped even on failure. */
const detachedPids: number[] = [];
let dataDir: string | null = null;

afterEach(() => {
  for (const agent of agents) agent.kill('SIGKILL');
  agents.length = 0;
  for (const pid of detachedPids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  detachedPids.length = 0;
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

interface DetachedReply {
  state: { instanceId: string; pid: number; port: number; startedAt: string } | null;
  reason: string | null;
}

/** Resolve with the agent's one 'detached' reply; reject on its 'error'. */
function detachedReply(child: ChildProcessWithoutNullStreams): Promise<DetachedReply> {
  return new Promise((resolve, reject) => {
    let buffered = '';
    const timer = setTimeout(() => reject(new Error(`no reply: ${buffered}`)), 20_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffered += chunk;
      for (const line of buffered.split('\n')) {
        let message: { type?: string; state?: DetachedReply['state']; reason?: string | null };
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          continue;
        }
        if (message.type === 'detached') {
          clearTimeout(timer);
          resolve({ state: message.state ?? null, reason: message.reason ?? null });
          return;
        }
        if (message.type === 'error') {
          clearTimeout(timer);
          reject(new Error(line));
          return;
        }
      }
    });
  });
}

/** One agent invocation for one detached verb, the way ssh.ts uses them. */
async function detachedCall(
  inDataDir: string,
  request: Parameters<typeof encodeAgentMessage>[0],
): Promise<DetachedReply> {
  const child = startAgent(inDataDir);
  const reply = detachedReply(child);
  child.stdin.write(encodeAgentMessage(request));
  return reply;
}

function makeInstanceDir(inDataDir: string, instanceId: string): string {
  const baseDir = path.join(inDataDir, 't3', instanceId);
  fs.mkdirSync(baseDir, { recursive: true });
  return baseDir;
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

/**
 * The one narrow exception to the teardown above: a detached managed T3
 * instance survives its agent (and therefore a daemon restart on the hub),
 * and a *later* agent invocation finds it by the target-side record and
 * stops it. Real processes, killed the way sshd kills agents.
 */
describe('target agent detached services', () => {
  it('keeps a detached instance alive across agents and stops it from a fresh one', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-agent-'));
    const baseDir = makeInstanceDir(dir, 'inst-1');
    const spec = { argv: ['sleep', '60'], cwd: baseDir, instanceId: 'inst-1', port: 4801, baseDir };

    const first = startAgent(dir);
    const reply = detachedReply(first);
    first.stdin.write(encodeAgentMessage({ type: 'detached-spawn', spec }));
    const spawned = await reply;
    const pid = spawned.state?.pid;
    expect(pid).toBeTypeOf('number');
    detachedPids.push(pid as number);
    expect(alive(pid as number)).toBe(true);

    // Exactly what sshd does to the agent when its channel goes away — the
    // pty children die to this (above), the detached instance must not.
    const closed = new Promise<void>((resolve) => first.once('close', () => resolve()));
    first.kill('SIGHUP');
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(alive(pid as number)).toBe(true);

    // A fresh agent — a reconnect — finds the instance by the record alone.
    const inspected = await detachedCall(dir, {
      type: 'detached-inspect',
      instanceId: 'inst-1',
      baseDir,
    });
    expect(inspected.state?.pid).toBe(pid);
    expect(inspected.reason).toBeNull();

    // And yet another invocation stops the process it never spawned.
    await detachedCall(dir, { type: 'detached-stop', instanceId: 'inst-1', baseDir });
    await waitUntilGone(pid as number);
    expect(alive(pid as number)).toBe(false);
  }, 60_000);

  it('reports an instance that died between agents as gone, and never relaunches it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-agent-'));
    const baseDir = makeInstanceDir(dir, 'inst-2');
    const spec = { argv: ['sleep', '60'], cwd: baseDir, instanceId: 'inst-2', port: 4802, baseDir };

    const spawned = await detachedCall(dir, { type: 'detached-spawn', spec });
    const pid = spawned.state?.pid as number;
    detachedPids.push(pid);

    // The instance dies while nobody is connected.
    process.kill(pid, 'SIGKILL');
    await waitUntilGone(pid);

    const inspected = await detachedCall(dir, {
      type: 'detached-inspect',
      instanceId: 'inst-2',
      baseDir,
    });
    expect(inspected.state).toBeNull();
    expect(inspected.reason).toContain('no longer running');

    // Stopping what is already gone is a clean no-op, not an error.
    const stopped = await detachedCall(dir, {
      type: 'detached-stop',
      instanceId: 'inst-2',
      baseDir,
    });
    expect(stopped.state).toBeNull();
  }, 60_000);

  it('refuses a base dir outside the managed T3 directory', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-agent-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-outside-'));
    const spec = {
      argv: ['sleep', '60'],
      cwd: outside,
      instanceId: path.basename(outside),
      port: 4803,
      baseDir: outside,
    };
    await expect(detachedCall(dir, { type: 'detached-spawn', spec })).rejects.toThrow(
      /immediate child/,
    );
    fs.rmSync(outside, { recursive: true, force: true });
  }, 60_000);
});
