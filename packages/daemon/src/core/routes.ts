import {
  confirmWizardRequestSchema,
  createProfileRequestSchema,
  startWizardRequestSchema,
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

export function registerCoreRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/profiles', async () => ctx.profiles.list());

  app.post('/api/profiles', async (request, reply) => {
    const body = parseBody(createProfileRequestSchema, request.body);
    const profile = await ctx.profiles.create(body);
    return reply.code(201).send(profile);
  });

  app.patch<{ Params: IdParams }>('/api/profiles/:id', async (request) => {
    const body = parseBody(updateProfileRequestSchema, request.body);
    return ctx.profiles.update(request.params.id, body);
  });

  app.delete<{ Params: IdParams }>('/api/profiles/:id', async (request, reply) => {
    const purge = parsePurge(request.query);
    await ctx.profiles.remove(request.params.id, purge);
    return reply.code(204).send();
  });

  app.post<{ Params: IdParams }>('/api/profiles/:id/refresh', async (request, reply) => {
    await ctx.usage.refresh(request.params.id, { force: true });
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

  app.get<{ Params: WizardParams }>('/api/wizard/:profileId', async (request) =>
    ctx.profiles.wizardState(request.params.profileId),
  );

  app.post<{ Params: WizardParams }>('/api/wizard/:profileId/confirm', async (request) => {
    const body = parseBody(confirmWizardRequestSchema, request.body);
    return ctx.profiles.confirmWizard(request.params.profileId, body.label);
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
