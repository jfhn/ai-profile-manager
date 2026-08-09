/**
 * Execution targets, read-only.
 *
 * Response shapes:
 *   GET /api/targets              -> { targets: ExecutionTarget[] }
 *   GET /api/targets/:id/profiles -> { profiles: TargetProfileSummary[] }
 *
 * The registry is the single source of truth here — nothing is filtered or
 * enriched, and nothing on either payload is secret (an ExecutionTarget carries
 * identity and capabilities only, a TargetProfileSummary neither home nor
 * credentials). Registering a target is deliberately not exposed: approving a
 * machine happens on this machine, not over the API.
 */
import type { FastifyInstance } from 'fastify';
import type { TargetProfilesResponse, TargetsResponse } from '@apm/shared';
import type { AppContext } from '../context.js';
import { toApiFailure } from './errors.js';

export function registerTargetRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/targets', async (): Promise<TargetsResponse> => ({ targets: ctx.targets.list() }));

  app.get<{ Params: { id: string } }>(
    '/api/targets/:id/profiles',
    async (req): Promise<TargetProfilesResponse> => {
      try {
        return { profiles: await ctx.targets.profiles(req.params.id) };
      } catch (error: unknown) {
        throw toApiFailure(error);
      }
    },
  );
}
