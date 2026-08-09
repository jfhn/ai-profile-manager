/**
 * Remote target agent. It exposes the local transport over a small JSON-lines
 * protocol so SSH never has to carry a user-controlled command string.
 */
import readline from 'node:readline';
import { isTransportError, type PtyHandle, type TransportErrorCode } from '@apm/shared';
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

export async function runTargetAgent(): Promise<void> {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  // A broken SSH channel closes the request stream, which makes servePty close
  // its handle instead of leaving the remote child behind.
  process.stdout.on('error', () => input.close());
  const iterator = input[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done) return;

  const parsed = parseRequest(first.value);
  if (!parsed) return;

  const config = resolveConfig();
  const profiles = createProfileService(config, createEventBus());
  const transport = createLocalTransport({ profiles });

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
  send({ type: 'ready', handleId: pty.id });
  let settled = false;
  let finish: (() => void) | undefined;
  const exited = new Promise<void>((resolve) => void (finish = resolve));

  pty.onData((data) => send({ type: 'data', data }));
  pty.onError((error) => sendError(error.code, error.message));
  pty.onExit((status) => {
    if (settled) return;
    settled = true;
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
