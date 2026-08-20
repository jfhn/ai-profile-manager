import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { Profile, TerminalServerMessage } from '@apm/shared';
import { resolveConfig } from '../config.js';
import type { AppContext, EventBus, ProfileService } from '../context.js';
import { createLocalTransport } from '../targets/local.js';
import { createTargetRegistry } from '../targets/registry.js';
import {
  createFakeRemoteTransport,
  type FakeRemoteTransport,
} from '../targets/test-support/fake-remote.js';
import { createSessionHost, type SessionHostInternals } from './host.js';
import { attachTerminalWs, type TerminalWsHandle } from './ws.js';

const TOKEN = 'test-token';

const profile: Profile = {
  id: 'profile-1',
  provider: 'claude',
  label: 'work',
  home: '/tmp/apm-ws-home',
  homeKind: 'external',
  identity: null,
  status: 'active',
  statusReason: null,
  enabled: true,
  createdAt: new Date().toISOString(),
};

const profiles = {
  list: () => [profile],
  get: (id: string) => (id === profile.id ? profile : null),
  envFor: () => ({ session: { CLAUDE_CONFIG_DIR: profile.home }, appOnly: null }),
} as Partial<ProfileService> as ProfileService;

const events: EventBus = { emit: () => undefined, subscribe: () => () => undefined };

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for condition');
}

describe('terminal websocket', () => {
  let dataDir: string;
  let host: SessionHostInternals;
  let server: http.Server;
  let port: number;
  let remote: FakeRemoteTransport;
  let terminalWs: TerminalWsHandle;

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-ws-'));
    const config = { ...resolveConfig({ dataDir }), token: TOKEN };
    remote = createFakeRemoteTransport({
      id: 'workstation',
      profiles: [
        {
          id: 'remote-profile',
          provider: 'claude',
          label: 'remote',
          status: 'active',
          enabled: true,
        },
      ],
    });
    const targets = createTargetRegistry(
      createLocalTransport({ profiles, shimsDir: config.shimsDir }),
      [remote],
    );
    host = createSessionHost(config, events, profiles, { targets });
    const ctx = {
      config,
      events,
      profiles,
      sessions: host,
      targets,
      usage: {},
    } as unknown as AppContext;

    server = http.createServer((_req, res) => res.end('ok'));
    terminalWs = attachTerminalWs(server, ctx);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    port = typeof address === 'object' && address !== null ? address.port : 0;
  });

  afterEach(async () => {
    await terminalWs.close();
    await host.shutdown();
    if (server.listening) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function connect(sessionId: string, query = `token=${TOKEN}`, headers?: Record<string, string>) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal/${sessionId}?${query}`, {
      headers,
    });
    const messages: TerminalServerMessage[] = [];
    ws.on('message', (raw) => messages.push(JSON.parse(raw.toString()) as TerminalServerMessage));
    return { ws, messages };
  }

  function expectRejected(ws: WebSocket, status: number): Promise<void> {
    return new Promise((resolve, reject) => {
      ws.on('error', (error: Error) => {
        try {
          expect(error.message).toContain(String(status));
          resolve();
        } catch (assertion: unknown) {
          reject(assertion as Error);
        }
      });
      ws.on('open', () => reject(new Error(`expected ${status}, got an upgrade`)));
    });
  }

  it('replays scrollback, streams live output and forwards input', async () => {
    const session = await host.create({
      profileId: profile.id,
      app: 'sh',
      args: ['-c', 'echo ready; while read line; do echo "got:$line"; done'],
      cwd: dataDir,
    });

    const { ws, messages } = connect(session.id);
    await new Promise<void>((resolve) => ws.on('open', resolve));
    await waitFor(() => messages.length > 0);
    expect(messages[0]?.type).toBe('scrollback');

    await waitFor(() => host.streams(session.id)?.session().attachedClients === 1);

    ws.send(JSON.stringify({ type: 'input', data: 'hello\r' }));
    const text = () => messages.map((m) => ('data' in m ? m.data : '')).join('');
    await waitFor(() => text().includes('got:hello'));

    ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
    await waitFor(() => host.streams(session.id)?.session().cols === 120);
    expect(host.streams(session.id)?.session().rows).toBe(40);

    // Invalid frames are ignored, not fatal.
    ws.send('not json');
    ws.send(JSON.stringify({ type: 'nonsense' }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ws.readyState).toBe(WebSocket.OPEN);

    // Closing detaches without killing the pty.
    ws.close();
    await waitFor(() => host.streams(session.id)?.session().attachedClients === 0);
    expect(host.streams(session.id)?.session().status).toBe('running');

    // A second client replays what the first one saw.
    const second = connect(session.id);
    await new Promise<void>((resolve) => second.ws.on('open', resolve));
    await waitFor(() => second.messages.length > 0);
    const replay = second.messages[0];
    expect(replay?.type).toBe('scrollback');
    expect(replay && 'data' in replay ? replay.data : '').toContain('got:hello');
    second.ws.close();
  });

  it('sends scrollback then exit for an already exited session', async () => {
    const session = await host.create({
      profileId: profile.id,
      app: 'sh',
      args: ['-c', 'echo bye; exit 7'],
      cwd: dataDir,
    });
    await waitFor(() => host.streams(session.id)?.session().status === 'exited');

    const { ws, messages } = connect(session.id);
    await new Promise<void>((resolve) => ws.on('open', resolve));
    await waitFor(() => messages.length >= 2);
    expect(messages[0]?.type).toBe('scrollback');
    expect(messages[1]).toEqual({ type: 'exit', exitCode: 7, signal: null });
    ws.close();
  });

  it('sends an exit frame to attached clients when the pty exits', async () => {
    const session = await host.create({
      profileId: profile.id,
      app: 'sh',
      args: ['-c', 'read line; exit 5'],
      cwd: dataDir,
    });
    const { ws, messages } = connect(session.id);
    await new Promise<void>((resolve) => ws.on('open', resolve));
    await waitFor(() => host.streams(session.id)?.session().attachedClients === 1);

    ws.send(JSON.stringify({ type: 'input', data: 'x\r' }));
    await waitFor(() => messages.some((message) => message.type === 'exit'));
    expect(messages.find((message) => message.type === 'exit')).toEqual({
      type: 'exit',
      exitCode: 5,
      signal: null,
    });
    ws.close();
  });

  it('keeps a remote pty across disconnects and forwards runtime failures', async () => {
    const session = await host.create({
      targetId: 'workstation',
      profileId: 'remote-profile',
      app: 'claude',
    });
    const first = connect(session.id);
    await new Promise<void>((resolve) => first.ws.on('open', resolve));
    await waitFor(() => host.streams(session.id)?.session().attachedClients === 1);

    remote.lastPty().emit('before detach\n');
    await waitFor(() =>
      first.messages.some((message) => message.type === 'data' && message.data.includes('before')),
    );
    first.ws.close();
    await waitFor(() => host.streams(session.id)?.session().attachedClients === 0);
    expect(remote.lastPty().exited).toBe(false);

    remote.lastPty().emit('while detached\n');
    const second = connect(session.id);
    await new Promise<void>((resolve) => second.ws.on('open', resolve));
    await waitFor(() => second.messages.length > 0);
    expect(second.messages[0]).toMatchObject({ type: 'scrollback' });
    expect(second.messages[0]?.type === 'scrollback' ? second.messages[0].data : '').toContain(
      'while detached',
    );

    second.ws.send(JSON.stringify({ type: 'input', data: 'hello' }));
    second.ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 35 }));
    await waitFor(() => remote.lastPty().writes.length === 1);
    expect(remote.lastPty().writes).toEqual(['hello']);
    await waitFor(() => remote.lastPty().resizes.length === 1);
    expect(remote.lastPty().resizes).toEqual([{ cols: 100, rows: 35 }]);

    remote.lastPty().fail('unreachable', 'remote connection failed');
    await waitFor(() => second.messages.some((message) => message.type === 'error'));
    expect(second.messages).toContainEqual({ type: 'error', message: 'remote connection failed' });
    expect(second.messages).toContainEqual({ type: 'exit', exitCode: 1, signal: null });
    second.ws.close();
  });

  it('kills a connection-bound remote pty when its websocket disconnects', async () => {
    const session = await host.create({
      targetId: 'workstation',
      profileId: 'remote-profile',
      app: 'claude',
      lifecycle: 'connection-bound',
    });
    const { ws } = connect(session.id);
    await new Promise<void>((resolve) => ws.on('open', resolve));
    await waitFor(() => host.streams(session.id)?.session().attachedClients === 1);

    ws.close();
    await waitFor(() => remote.lastPty().signals.length === 1);
    expect(remote.lastPty().signals).toEqual(['SIGHUP']);
  });

  it('disconnects attached clients during shutdown so the HTTP server can close', async () => {
    const session = await host.create({
      targetId: 'workstation',
      profileId: 'remote-profile',
      app: 'claude',
    });
    const { ws } = connect(session.id);
    await new Promise<void>((resolve) => ws.on('open', resolve));
    await waitFor(() => host.streams(session.id)?.session().attachedClients === 1);
    const disconnected = new Promise<void>((resolve) => ws.once('close', () => resolve()));

    await terminalWs.close();

    await disconnected;
    expect(ws.readyState).toBe(WebSocket.CLOSED);
    expect(host.streams(session.id)?.session().attachedClients).toBe(0);
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    expect(server.listening).toBe(false);
  });

  it('rejects bad tokens, foreign origins and unknown sessions before touching a pty', async () => {
    const session = await host.create({
      profileId: profile.id,
      app: 'sh',
      args: ['-c', 'sleep 5'],
      cwd: dataDir,
    });

    await expectRejected(connect(session.id, 'token=wrong').ws, 401);
    await expectRejected(connect(session.id, '').ws, 401);
    await expectRejected(
      connect(session.id, `token=${TOKEN}`, { origin: 'https://evil.example' }).ws,
      403,
    );
    await expectRejected(connect('no-such-session').ws, 404);
    expect(host.streams(session.id)?.session().attachedClients).toBe(0);
  });
});
