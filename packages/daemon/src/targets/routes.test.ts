import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Profile } from '@apm/shared';
import { ApiFailure, type AppContext, type ProfileService } from '../context.js';
import { createLocalTransport } from './local.js';
import { createTargetRegistry } from './registry.js';
import { registerTargetRoutes } from './routes.js';
import { createFakeRemoteTransport } from './test-support/fake-remote.js';

const LOCAL_PROFILE: Profile = {
  id: 'claude-1',
  provider: 'claude',
  label: 'work',
  home: '/tmp/apm-claude-home',
  homeKind: 'external',
  identity: null,
  status: 'active',
  statusReason: null,
  enabled: true,
  createdAt: new Date().toISOString(),
};

let app: FastifyInstance;

beforeAll(async () => {
  const profiles: Pick<ProfileService, 'list' | 'envFor'> = {
    list: () => [LOCAL_PROFILE],
    envFor: () => ({}),
  };
  const remote = createFakeRemoteTransport({
    id: 'dev-box',
    label: 'dev box',
    profiles: [
      { id: 'claude-remote', provider: 'claude', label: 'dev', status: 'active', enabled: true },
    ],
  });
  const targets = createTargetRegistry(createLocalTransport({ profiles }), [remote]);

  app = Fastify({ logger: false });
  app.setErrorHandler((error: unknown, _req, reply) => {
    const failure = error as ApiFailure;
    return reply
      .code(failure.statusCode ?? 500)
      .send({ error: { code: failure.code, message: failure.message } });
  });
  registerTargetRoutes(app, { targets } as Partial<AppContext> as AppContext);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('target routes', () => {
  // The first injected request pays Fastify's cold-start cost, which can
  // exceed the default 5s timeout on a loaded machine.
  it('lists every registered target with its capabilities', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/targets' });
    expect(response.statusCode).toBe(200);
    const { targets } = response.json();
    expect(targets.map((target: { id: string }) => target.id)).toEqual(['local', 'dev-box']);
    expect(targets[1]).toMatchObject({ kind: 'remote', approved: true });
    expect(targets[1].capabilities).toContain('profiles');
  }, 20_000);

  it('answers a target’s own profile list, without homes or credentials', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/targets/dev-box/profiles' });
    expect(response.statusCode).toBe(200);
    expect(response.json().profiles).toEqual([
      { id: 'claude-remote', provider: 'claude', label: 'dev', status: 'active', enabled: true },
    ]);
    expect(response.payload).not.toContain('home');
  });

  it('maps an unknown target onto the shared transport error codes', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/targets/nope/profiles' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('target-not-found');
  });
});
