/**
 * Remote target agent. It exposes the local transport over a small JSON-lines
 * protocol so SSH never has to carry a user-controlled command string.
 *
 * Nothing it spawns may outlive it. When the SSH channel drops, sshd SIGHUPs
 * this process, and a pty child is a session leader — so without the teardown
 * below the child survives, keeps its ports, and becomes a server nobody is
 * supervising. Every way this process can end is therefore wired to the same
 * cleanup: stdin EOF, SIGHUP/SIGTERM/SIGINT, and `exit` as the last resort.
 *
 * One narrow, deliberate exception: `detached-*` requests for managed T3
 * instances. Those are spawned in their own session by the local transport,
 * recorded in a state file inside their managed base dir, and *meant* to
 * survive this agent — a daemon restart on the hub must not take the instance
 * down. They are never registered with the teardown below, and everything else
 * (every pty, every exec) keeps the kill-everything contract.
 */
import readline from 'node:readline';
import { isTransportError, type PtyHandle, type TransportErrorCode } from '@apm/shared';
import { killProcessGroup } from './local.js';
import { resolveConfig } from '../config.js';
import { createEventBus } from '../core/events.js';
import { createProfileService } from '../core/profiles.js';
import {
  agentRequestSchema,
  encodeAgentMessage,
  type AgentRequest,
  type AgentResponse,
} from './protocol.js';
import { createLocalTransport } from './local.js';

/** The pty this agent is serving, if any — the thing teardown has to reach. */
let livePty: PtyHandle | null = null;
let teardownInstalled = false;

/**
 * Kill whatever this agent spawned. Safe to call repeatedly and from a
 * synchronous `exit` handler: `PtyHandle.close()` does its killing before it
 * awaits anything, so the signals are delivered even as the process leaves.
 */
function tearDown(): void {
  const pty = livePty;
  livePty = null;
  if (!pty) return;
  // Belt and braces: close() signals the child's whole process group, and the
  // group is derived from the handle id when the handle is already inert.
  void pty.close().catch(() => undefined);
  const pid = Number(/(\d+)$/.exec(pty.id)?.[1] ?? Number.NaN);
  killProcessGroup(pid, 'SIGKILL');
}

function installTeardown(input: readline.Interface): void {
  if (teardownInstalled) return;
  teardownInstalled = true;
  // sshd SIGHUPs the remote command when the channel drops; node's default
  // action for it is a silent exit, which is exactly how children were orphaned.
  for (const signal of ['SIGHUP', 'SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      tearDown();
      input.close();
      process.exit(0);
    });
  }
  process.on('exit', tearDown);
  // EOF on the request stream means the same thing as a dropped channel.
  process.stdin.on('end', tearDown);
  input.on('close', tearDown);
}

export async function runTargetAgent(): Promise<void> {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  // A broken SSH channel closes the request stream, which makes servePty close
  // its handle instead of leaving the remote child behind.
  process.stdout.on('error', () => input.close());
  installTeardown(input);
  const iterator = input[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done) return;

  const parsed = parseRequest(first.value);
  if (!parsed) return;

  const config = resolveConfig();
  const profiles = createProfileService(config, createEventBus());
  // The detached scope is pinned to this machine's own managed T3 dir — the
  // same directory `apm pair` trusts — so no request can point it elsewhere.
  const transport = createLocalTransport({ profiles, detachedDir: config.t3Dir });

  try {
    switch (parsed.type) {
      case 'probe':
        send({ type: 'ready' });
        return;
      case 'profiles':
        send({ type: 'profiles', profiles: await transport.profiles() });
        return;
      case 'exec':
        send({ type: 'result', result: await transport.exec(parsed.spec, parsed.options) });
        return;
      case 'pty':
        await servePty(await transport.openPty(parsed.spec), iterator);
        return;
      case 'detached-spawn':
        // Deliberately not registered with tearDown: this is the one process
        // class that must survive this agent (see the module comment).
        send({ type: 'detached', state: await transport.spawnDetached(parsed.spec), reason: null });
        return;
      case 'detached-inspect': {
        const inspection = await transport.inspectDetached(parsed.instanceId, parsed.baseDir);
        send({ type: 'detached', state: inspection.state, reason: inspection.reason });
        return;
      }
      case 'detached-stop':
        await transport.stopDetached(parsed.instanceId, parsed.baseDir);
        send({ type: 'detached', state: null, reason: null });
        return;
      default:
        sendError('spawn-failed', 'Expected an operation as the first agent request');
    }
  } catch (error: unknown) {
    if (isTransportError(error)) sendError(error.code, error.message);
    else sendError('spawn-failed', error instanceof Error ? error.message : String(error));
  } finally {
    input.close();
    await transport.close();
  }
}

async function servePty(pty: PtyHandle, iterator: AsyncIterator<string>): Promise<void> {
  livePty = pty;
  send({ type: 'ready', handleId: pty.id });
  let settled = false;
  let finish: (() => void) | undefined;
  const exited = new Promise<void>((resolve) => void (finish = resolve));

  pty.onData((data) => send({ type: 'data', data }));
  pty.onError((error) => sendError(error.code, error.message));
  pty.onExit((status) => {
    if (settled) return;
    settled = true;
    livePty = null;
    send({ type: 'exit', ...status });
    finish?.();
  });

  void (async () => {
    while (!settled) {
      const next = await iterator.next();
      if (next.done) break;
      const request = parseRequest(next.value);
      if (!request) continue;
      switch (request.type) {
        case 'input':
          pty.write(request.data);
          break;
        case 'resize':
          pty.resize(request.cols, request.rows);
          break;
        case 'signal':
          pty.signal(request.signal);
          break;
        case 'close':
          await pty.close();
          break;
        default:
          sendError('spawn-failed', `Unexpected ${request.type} request for a live pty`);
      }
    }
    if (!settled) await pty.close();
  })().catch((error: unknown) => {
    sendError('closed', error instanceof Error ? error.message : String(error));
    void pty.close();
  });

  await exited;
}

function parseRequest(line: string): AgentRequest | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    sendError('spawn-failed', 'Malformed target-agent request');
    return null;
  }
  const parsed = agentRequestSchema.safeParse(value);
  if (!parsed.success) {
    sendError('spawn-failed', 'Invalid target-agent request');
    return null;
  }
  return parsed.data;
}

function send(message: AgentResponse): void {
  process.stdout.write(encodeAgentMessage(message));
}

function sendError(code: TransportErrorCode, message: string): void {
  send({ type: 'error', code, message });
}
