import {
  confirmWizardRequestSchema,
  createProfileRequestSchema,
  profileIdSchema,
  providerIdSchema,
  startWizardRequestSchema,
  updateDefaultProfileRequestSchema,
  updateProfileRequestSchema,
  type DiscoveryResponse,
} from '@apm/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodType } from 'zod';
import { ApiFailure, type AppContext } from '../context.js';

interface IdParams {
  id: string;
}

interface WizardParams {
  profileId: string;
}

interface ProviderParams {
  provider: string;
}

export function registerCoreRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/profiles', async () => ctx.profiles.list());

  app.get('/api/defaults', async () => ({ defaultProfileIds: ctx.profiles.defaults() }));

  app.put<{ Params: ProviderParams }>('/api/defaults/:provider', async (request) => {
    const provider = parseBody(providerIdSchema, request.params.provider);
    const body = parseBody(updateDefaultProfileRequestSchema, request.body);
    return { defaultProfileIds: ctx.profiles.setDefault(provider, body.profileId) };
  });

  app.post('/api/profiles', async (request, reply) => {
    const body = parseBody(createProfileRequestSchema, request.body);
    const profile = await ctx.profiles.create(body);
    return reply.code(201).send(profile);
  });

  app.patch<{ Params: IdParams }>('/api/profiles/:id', async (request) => {
    const id = parseBody(profileIdSchema, request.params.id);
    const body = parseBody(updateProfileRequestSchema, request.body);
    return ctx.profiles.update(id, body);
  });

  app.delete<{ Params: IdParams }>('/api/profiles/:id', async (request, reply) => {
    const id = parseBody(profileIdSchema, request.params.id);
    const purge = parsePurge(request.query);
    await ctx.profiles.remove(id, purge);
    return reply.code(204).send();
  });

  app.post<{ Params: IdParams }>('/api/profiles/:id/sync-enable', async (request) => {
    const id = parseBody(profileIdSchema, request.params.id);
    return ctx.profiles.enableSync(id);
  });

  app.post<{ Params: IdParams }>('/api/profiles/:id/refresh', async (request, reply) => {
    const id = parseBody(profileIdSchema, request.params.id);
    await ctx.usage.refresh(id, { force: true });
    return reply.code(204).send();
  });

  app.get('/api/usage', async () => ctx.usage.latest());

  app.post('/api/usage/refresh', async (_request, reply) => {
    await ctx.usage.refresh(undefined, { force: true });
    return reply.code(204).send();
  });

  app.get('/api/discovery', async (): Promise<DiscoveryResponse> => ({
    candidates: await ctx.profiles.discovery(),
  }));

  app.post('/api/wizard', async (request, reply) => {
    const body = parseBody(startWizardRequestSchema, request.body);
    const state = await ctx.profiles.startWizard(body.provider);
    return reply.code(201).send(state);
  });

  app.get<{ Params: WizardParams }>('/api/wizard/:profileId', async (request) => {
    const profileId = parseBody(profileIdSchema, request.params.profileId);
    return ctx.profiles.wizardState(profileId);
  });

  app.post<{ Params: WizardParams }>('/api/wizard/:profileId/confirm', async (request) => {
    const profileId = parseBody(profileIdSchema, request.params.profileId);
    const body = parseBody(confirmWizardRequestSchema, request.body);
    return ctx.profiles.confirmWizard(profileId, body.label);
  });
}

function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ApiFailure(
      400,
      'bad-request',
      result.error.issues.map((issue) => issue.message).join('; '),
    );
  }
  return result.data;
}

function parsePurge(query: unknown): boolean {
  if (!query || typeof query !== 'object') return false;
  const purge = (query as Record<string, unknown>).purge;
  if (purge === undefined || purge === 'false') return false;
  if (purge === 'true') return true;
  throw new ApiFailure(400, 'bad-request', 'purge must be true or false');
}
