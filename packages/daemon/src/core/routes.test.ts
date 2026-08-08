import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppContext, RefreshOptions, UsageService } from '../context.js';
import { registerCoreRoutes } from './routes.js';

const refresh = vi.fn(
  async (_profileId?: string, _options?: RefreshOptions): Promise<void> => undefined,
);
let app: FastifyInstance;

beforeAll(async () => {
  const usage = { refresh } as Partial<UsageService> as UsageService;
  app = Fastify({ logger: false });
  registerCoreRoutes(app, { usage } as Partial<AppContext> as AppContext);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => refresh.mockClear());

describe('core routes', () => {
  // The first injected request pays Fastify's cold-start cost, which can
  // exceed the default 5s timeout on a loaded machine.
  it('forces a per-profile refresh from POST /api/profiles/:id/refresh', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/profiles/abc/refresh' });
    expect(response.statusCode).toBe(204);
    expect(refresh.mock.calls).toEqual([['abc', { force: true }]]);
  }, 20_000);

  it('forces a refresh-all from POST /api/usage/refresh', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/usage/refresh' });
    expect(response.statusCode).toBe(204);
    expect(refresh.mock.calls).toEqual([[undefined, { force: true }]]);
  });
});
