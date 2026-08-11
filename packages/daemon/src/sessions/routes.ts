/**
 * Session REST endpoints. Auth, origin and ApiFailure -> ApiError mapping are
 * global in server.ts; these handlers only validate bodies and delegate.
 *
 * Response shapes:
 *   GET    /api/sessions        -> { sessions: TerminalSession[] }
 *   POST   /api/sessions        -> TerminalSession (201)
 *   POST   /api/sessions/:id/resize -> 204
 *   DELETE /api/sessions/:id    -> 204
 *   GET    /api/recent-dirs     -> RecentDirsResponse
 */
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  createSessionRequestSchema,
  type RecentDirsResponse,
  type TerminalSession,
} from '@apm/shared';
import { ApiFailure, type AppContext } from '../context.js';

const resizeRequestSchema = z.object({
  cols: z.number().int().min(2).max(1000),
  rows: z.number().int().min(2).max(500),
});

export function registerSessionRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/sessions', async (): Promise<{ sessions: TerminalSession[] }> => ({
    sessions: ctx.sessions.list(),
  }));

  app.post('/api/sessions', async (req, reply): Promise<TerminalSession> => {
    const parsed = parse(createSessionRequestSchema, req.body);
    const session = await ctx.sessions.create(parsed);
    reply.code(201);
    return session;
  });

  app.post<{ Params: { id: string } }>('/api/sessions/:id/resize', async (req, reply) => {
    const { cols, rows } = parse(resizeRequestSchema, req.body);
    ctx.sessions.resize(req.params.id, cols, rows);
    return reply.code(204).send();
  });

  app.delete<{ Params: { id: string } }>('/api/sessions/:id', async (req, reply) => {
    const session = ctx.sessions.list().find((entry) => entry.id === req.params.id);
    if (!session) throw new ApiFailure(404, 'session-not-found', `No session ${req.params.id}`);
    if (session.status === 'running') ctx.sessions.kill(session.id);
    else ctx.sessions.dispose(session.id);
    return reply.code(204).send();
  });

  app.get('/api/recent-dirs', async (): Promise<RecentDirsResponse> => ({
    dirs: ctx.sessions.recentDirs(),
  }));
}

function parse<S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    throw new ApiFailure(400, 'bad-request', formatIssues(result.error));
  }
  return result.data;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) =>
      issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
    )
    .join('; ');
}
