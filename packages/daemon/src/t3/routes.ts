/**
 * Managed T3 instance endpoints.
 *
 * Response shapes:
 *   GET    /api/t3           -> { instances: T3Instance[] }
 *   POST   /api/t3           -> T3Instance (201)
 *   POST   /api/t3/:id/start -> T3Instance (running, or unhealthy/exited with statusReason)
 *   POST   /api/t3/:id/stop  -> T3Instance
 *   DELETE /api/t3/:id       -> 204
 */
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import { createT3InstanceRequestSchema, type T3Instance } from '@apm/shared';
import { ApiFailure, type AppContext } from '../context.js';

export function registerT3Routes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/t3', async (): Promise<{ instances: T3Instance[] }> => ({
    instances: ctx.t3.list(),
  }));

  app.post('/api/t3', async (req, reply): Promise<T3Instance> => {
    const parsed = createT3InstanceRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new ApiFailure(400, 'bad-request', formatIssues(parsed.error));
    const instance = await ctx.t3.create(parsed.data);
    reply.code(201);
    return instance;
  });

  app.post<{ Params: { id: string } }>(
    '/api/t3/:id/start',
    async (req): Promise<T3Instance> => ctx.t3.start(req.params.id),
  );

  app.post<{ Params: { id: string } }>(
    '/api/t3/:id/stop',
    async (req): Promise<T3Instance> => ctx.t3.stop(req.params.id),
  );

  app.delete<{ Params: { id: string } }>('/api/t3/:id', async (req, reply) => {
    await ctx.t3.remove(req.params.id);
    return reply.code(204).send();
  });
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => (issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
    .join('; ');
}
