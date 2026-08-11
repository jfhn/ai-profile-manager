/**
 * Discovering, approving and revoking a target over the API.
 *
 * The point of these tests is the seam between the file and the running
 * daemon: an approval has to land in targets.json *and* make the target
 * selectable at once, and a revocation has to leave the file *and* close the
 * connection, without a restart in either direction.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandResult, CommandSpec, ExecOptions, TargetTransport } from '@apm/shared';
import { resolveConfig, type DaemonConfig } from '../config.js';
import { ApiFailure, type AppContext, type ProfileService } from '../context.js';
import { readConfiguredTargets, type ConfiguredTarget } from './config.js';
import { createLocalTransport } from './local.js';
import { createTargetRegistry, type TargetRegistry } from './registry.js';
import { registerTargetRoutes } from './routes.js';
import { createFakeRemoteTransport, type FakeRemoteTransport } from './test-support/fake-remote.js';

const STATUS_JSON = JSON.stringify({
  Self: { HostName: 'hub', DNSName: 'hub.tailnet.ts.net.', OS: 'linux' },
  Peer: {
    'nodekey:aaa': {
      HostName: 'dev-box',
      DNSName: 'dev-box.tailnet.ts.net.',
      OS: 'linux',
      Online: true,
    },
    'nodekey:bbb': {
      HostName: 'laptop',
      DNSName: 'laptop.tailnet.ts.net.',
      OS: 'macOS',
      Online: false,
    },
  },
});

const noProfiles: Pick<ProfileService, 'list' | 'envFor'> = { list: () => [], envFor: () => ({}) };

let dataDir: string;
let config: DaemonConfig;
let app: FastifyInstance;
let targets: TargetRegistry;
/** Transports the routes created, so a test can watch one being closed. */
let created: FakeRemoteTransport[];
let status: Partial<CommandResult> | Error;

function exec(_spec: CommandSpec, _options?: ExecOptions): Promise<CommandResult> {
  if (status instanceof Error) return Promise.reject(status);
  return Promise.resolve({
    exitCode: status.exitCode ?? 0,
    signal: null,
    stdout: status.stdout ?? '',
    stderr: status.stderr ?? '',
  });
}

function createTransport(target: ConfiguredTarget): TargetTransport {
  const transport = createFakeRemoteTransport({
    id: target.id,
    label: target.label,
    approved: target.approved,
  });
  created.push(transport);
  return transport;
}

function writeTargetsFile(entries: unknown): void {
  fs.writeFileSync(config.targetsFile, JSON.stringify({ version: 1, targets: entries }));
}

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-target-admin-'));
  fs.mkdirSync(dataDir, { recursive: true });
  config = resolveConfig({ dataDir });
  created = [];
  status = { stdout: STATUS_JSON };
  targets = createTargetRegistry(createLocalTransport({ profiles: noProfiles }));

  app = Fastify({ logger: false });
  app.setErrorHandler((error: unknown, _req, reply) => {
    const failure = error as ApiFailure;
    return reply
      .code(failure.statusCode ?? 500)
      .send({ error: { code: failure.code, message: failure.message } });
  });
  registerTargetRoutes(app, { config, targets } as Partial<AppContext> as AppContext, {
    exec,
    createTransport,
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function add(body: unknown) {
  return app.inject({ method: 'POST', url: '/api/targets', payload: body });
}

describe('GET /api/targets/candidates', () => {
  // The first injected request pays Fastify's cold-start cost, which can
  // exceed the default 5s timeout on a loaded machine.
  it('lists the tailnet, without the hub, and says which machines are targets', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/targets/candidates' });
    expect(response.statusCode).toBe(200);
    expect(response.json().candidates).toEqual([
      {
        hostname: 'dev-box',
        dnsName: 'dev-box.tailnet.ts.net',
        address: 'dev-box.tailnet.ts.net',
        online: true,
        os: 'linux',
        registeredTargetId: null,
        suggestedId: 'dev-box',
      },
      {
        hostname: 'laptop',
        dnsName: 'laptop.tailnet.ts.net',
        address: 'laptop.tailnet.ts.net',
        online: false,
        os: 'macOS',
        registeredTargetId: null,
        suggestedId: 'laptop',
      },
    ]);
    // Listing a machine registers nothing: discovery is display-only.
    expect(targets.list().map((target) => target.id)).toEqual(['local']);
    expect(fs.existsSync(config.targetsFile)).toBe(false);
  }, 20_000);

  it('reports an approved machine as already added', async () => {
    await add({ id: 'dev-box', label: 'Dev box', address: 'dev-box.tailnet.ts.net' });

    const response = await app.inject({ method: 'GET', url: '/api/targets/candidates' });
    const [first, second] = response.json().candidates;
    expect(first).toMatchObject({ hostname: 'dev-box', registeredTargetId: 'dev-box' });
    expect(second).toMatchObject({ hostname: 'laptop', registeredTargetId: null });
  });

  it('fails cleanly when tailscale cannot answer', async () => {
    status = { exitCode: 1, stderr: 'Tailscale is stopped.' };
    const response = await app.inject({ method: 'GET', url: '/api/targets/candidates' });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('tailscale-unavailable');
    expect(response.json().error.message).toContain('Tailscale is stopped.');
  });
});

describe('POST /api/targets', () => {
  it('approves one machine, persists it and makes it selectable at once', async () => {
    const response = await add({
      id: 'dev-box',
      label: 'Dev box',
      address: 'dev-box.tailnet.ts.net',
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      id: 'dev-box',
      label: 'Dev box',
      kind: 'remote',
      approved: true,
    });

    // Persisted in the documented shape, approved because a human asked.
    expect(readConfiguredTargets(config)).toEqual([
      {
        id: 'dev-box',
        label: 'Dev box',
        transport: 'ssh',
        address: 'dev-box.tailnet.ts.net',
        approved: true,
      },
    ]);
    // Reloading the file as a restart would produces the same set.
    expect(JSON.parse(fs.readFileSync(config.targetsFile, 'utf8')).version).toBe(1);

    // Live, without a restart: the registry hands out its transport now.
    expect(targets.list().map((target) => target.id)).toEqual(['local', 'dev-box']);
    expect(targets.transportFor('dev-box').target.approved).toBe(true);
    const listed = await app.inject({ method: 'GET', url: '/api/targets' });
    expect(listed.json().targets.map((target: { id: string }) => target.id)).toEqual([
      'local',
      'dev-box',
    ]);
  });

  it('keeps entries somebody hand-wrote', async () => {
    writeTargetsFile([
      { id: 'old', label: 'Old', transport: 'ssh', address: 'old.example', approved: false },
    ]);

    await add({ id: 'dev-box', label: 'Dev box', address: 'dev-box.tailnet.ts.net' });

    expect(readConfiguredTargets(config).map((target) => target.id)).toEqual(['old', 'dev-box']);
    expect(readConfiguredTargets(config)[0]?.approved).toBe(false);
  });

  it('refuses the reserved id, a duplicate, and anything option-shaped', async () => {
    await add({ id: 'dev-box', label: 'Dev box', address: 'dev-box.tailnet.ts.net' });

    const reserved = await add({ id: 'local', label: 'Me', address: 'hub.tailnet.ts.net' });
    expect(reserved.statusCode).toBe(400);
    expect(reserved.json().error.message).toContain('reserved');

    const duplicate = await add({ id: 'dev-box', label: 'Again', address: 'other.tailnet.ts.net' });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe('target-exists');

    for (const body of [
      { id: 'evil', label: 'Evil', address: '-oProxyCommand=x' },
      { id: 'spaced', label: 'Spaced', address: 'dev box' },
      { id: 'no label', label: '', address: 'dev-box.tailnet.ts.net' },
      { id: 'extra', label: 'Extra', address: 'ok.example', approved: true },
      { label: 'No id', address: 'ok.example' },
    ]) {
      expect((await add(body)).statusCode).toBe(400);
    }

    // Exactly one target was ever written, and the registry agrees.
    expect(readConfiguredTargets(config).map((target) => target.id)).toEqual(['dev-box']);
    expect(targets.list().map((target) => target.id)).toEqual(['local', 'dev-box']);
  });

  it('refuses an address the tailnet never reported', async () => {
    const response = await add({
      id: 'elsewhere',
      label: 'Somewhere else',
      address: 'root@10.0.0.5',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('not-a-tailnet-machine');
    expect(targets.list().map((target) => target.id)).toEqual(['local']);
    expect(fs.existsSync(config.targetsFile)).toBe(false);
  });

  it('registers nothing when the target file cannot be read', async () => {
    fs.writeFileSync(config.targetsFile, '{ not json');
    const response = await add({
      id: 'dev-box',
      label: 'Dev box',
      address: 'dev-box.tailnet.ts.net',
    });
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe('target-config-invalid');
    expect(targets.list().map((target) => target.id)).toEqual(['local']);
  });
});

describe('DELETE /api/targets/:id', () => {
  it('revokes the machine, closes its connection and forgets it', async () => {
    await add({ id: 'dev-box', label: 'Dev box', address: 'dev-box.tailnet.ts.net' });
    const transport = created[0];
    expect(transport).toBeDefined();
    // Something is already running over that connection.
    const endpoint = await transport!.openEndpoint({ port: null });

    const response = await app.inject({ method: 'DELETE', url: '/api/targets/dev-box' });
    expect(response.statusCode).toBe(204);

    // Gone from the store, so a restart does not bring it back.
    expect(readConfiguredTargets(config)).toEqual([]);
    // Gone from the registry, and selecting it now fails like an unknown target.
    expect(targets.get('dev-box')).toBeNull();
    expect(() => targets.transportFor('dev-box')).toThrowError(/No target "dev-box"/);
    // In-flight work surfaces the transport's own closed/endpoint errors.
    await expect(transport!.exec({ argv: ['true'] })).rejects.toMatchObject({ code: 'closed' });
    expect((await endpoint.health()).state).toBe('closed');
  });

  it('refuses the local target and an id nobody knows', async () => {
    const local = await app.inject({ method: 'DELETE', url: '/api/targets/local' });
    expect(local.statusCode).toBe(400);
    expect(targets.get('local')).not.toBeNull();

    const unknown = await app.inject({ method: 'DELETE', url: '/api/targets/nope' });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe('target-not-found');
  });

  it('drops an entry a restart would still have loaded', async () => {
    // In the file but not in this registry — exactly what a hand-edit between
    // two starts looks like.
    writeTargetsFile([
      { id: 'stale', label: 'Stale', transport: 'ssh', address: 'stale.example', approved: true },
    ]);

    const response = await app.inject({ method: 'DELETE', url: '/api/targets/stale' });
    expect(response.statusCode).toBe(204);
    expect(readConfiguredTargets(config)).toEqual([]);
  });
});
