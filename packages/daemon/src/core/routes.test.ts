import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AppContext,
  CliToolService,
  ProfileService,
  RefreshOptions,
  UsageService,
} from '../context.js';
import { registerCoreRoutes } from './routes.js';

const refresh = vi.fn(
  async (_profileId?: string, _options?: RefreshOptions): Promise<void> => undefined,
);
const defaults = vi.fn(() => ({ claude: 'claude-work' }));
const setDefault = vi.fn((provider: 'claude' | 'codex' | 'cursor', profileId: string | null) =>
  profileId === null ? {} : { [provider]: profileId },
);
const listTools = vi.fn(async () => [
  { provider: 'codex' as const, label: 'Codex', state: 'missing' as const },
]);
const updateTool = vi.fn(async () => ({
  previousVersion: 'codex-cli 1.0.0',
  tool: {
    provider: 'codex' as const,
    label: 'Codex',
    state: 'installed' as const,
    executable: '/bin/codex',
    version: 'codex-cli 2.0.0',
  },
}));
let app: FastifyInstance;

beforeAll(async () => {
  const usage = { refresh } as Partial<UsageService> as UsageService;
  const profiles = { defaults, setDefault } as Partial<ProfileService> as ProfileService;
  const tools = { list: listTools, update: updateTool } as CliToolService;
  app = Fastify({ logger: false });
  registerCoreRoutes(app, { usage, profiles, tools } as Partial<AppContext> as AppContext);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  refresh.mockClear();
  defaults.mockClear();
  setDefault.mockClear();
  listTools.mockClear();
  updateTool.mockClear();
});

describe('core routes', () => {
  // The first injected request pays Fastify's cold-start cost, which can
  // exceed the default 5s timeout on a loaded machine.
  it('forces a per-profile refresh from POST /api/profiles/:id/refresh', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/profiles/abc/refresh' });
    expect(response.statusCode).toBe(204);
    expect(refresh.mock.calls).toEqual([['abc', { force: true }]]);
  }, 20_000);

  it('preserves an encoded opaque profile id in route parameters', async () => {
    const profileId = ' work/個人 ! ';
    const response = await app.inject({
      method: 'POST',
      url: `/api/profiles/${encodeURIComponent(profileId)}/refresh`,
    });

    expect(response.statusCode).toBe(204);
    expect(refresh).toHaveBeenCalledWith(profileId, { force: true });
  });

  it('forces a refresh-all from POST /api/usage/refresh', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/usage/refresh' });
    expect(response.statusCode).toBe(204);
    expect(refresh.mock.calls).toEqual([[undefined, { force: true }]]);
  });

  it('lists tools and updates one validated provider', async () => {
    const listed = await app.inject({ method: 'GET', url: '/api/tools' });
    expect(listed.json()).toEqual({
      tools: [{ provider: 'codex', label: 'Codex', state: 'missing' }],
    });

    const updated = await app.inject({ method: 'POST', url: '/api/tools/codex/update' });
    expect(updated.statusCode).toBe(200);
    expect(updateTool).toHaveBeenCalledWith('codex');

    const unknown = await app.inject({ method: 'POST', url: '/api/tools/gemini/update' });
    expect(unknown.statusCode).toBe(400);
  });

  it('gets and updates provider defaults through validated routes', async () => {
    const current = await app.inject({ method: 'GET', url: '/api/defaults' });
    expect(current.json()).toEqual({ defaultProfileIds: { claude: 'claude-work' } });

    const updated = await app.inject({
      method: 'PUT',
      url: '/api/defaults/codex',
      payload: { profileId: 'codex-personal' },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toEqual({ defaultProfileIds: { codex: 'codex-personal' } });
    expect(setDefault).toHaveBeenCalledWith('codex', 'codex-personal');

    const cleared = await app.inject({
      method: 'PUT',
      url: '/api/defaults/claude',
      payload: { profileId: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(setDefault).toHaveBeenCalledWith('claude', null);
  });

  it('preserves a bounded opaque default id exactly', async () => {
    const profileId = ' work/個人 ! ';
    const response = await app.inject({
      method: 'PUT',
      url: '/api/defaults/claude',
      payload: { profileId },
    });

    expect(response.statusCode).toBe(200);
    expect(setDefault).toHaveBeenCalledWith('claude', profileId);
  });

  it('rejects unknown providers and malformed default requests', async () => {
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/defaults/openai',
          payload: { profileId: null },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: 'PUT', url: '/api/defaults/claude', payload: {} })).statusCode,
    ).toBe(400);
    for (const profileId of ['bad\u0000id', `${'é'.repeat(128)}a`, '   ']) {
      expect(
        (
          await app.inject({
            method: 'PUT',
            url: '/api/defaults/claude',
            payload: { profileId },
          })
        ).statusCode,
      ).toBe(400);
    }
    expect(setDefault).not.toHaveBeenCalled();
  });
});
