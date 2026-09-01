/**
 * Execution targets: reading them, and the two acts that change the set.
 *
 * Response shapes:
 *   GET    /api/targets              -> { targets: ExecutionTarget[] }
 *   GET    /api/targets/candidates   -> { candidates: TargetCandidate[] }
 *   GET    /api/targets/:id/profiles -> { profiles: TargetProfileSummary[] }
 *   POST   /api/targets              -> ExecutionTarget (201)
 *   DELETE /api/targets/:id          -> 204
 *
 * This module owns the whole /api/targets namespace, and the profile list is
 * the one both consumers share: `apm run --target` resolves a profile name
 * through it, and the web target view reads the same list.
 *
 * Nothing on any of these payloads is secret: an ExecutionTarget carries
 * identity and capabilities only, a TargetProfileSummary neither home nor
 * credentials, and a TargetCandidate is a name on the tailnet.
 *
 * Approval is the boundary. `GET /api/targets/candidates` grants nothing — it
 * lists machines, and a machine stays inert until a human posts *that one*
 * machine to `POST /api/targets`. There is no bulk approve, nothing is ever
 * approved implicitly, and the address must belong to a machine the tailnet
 * just reported — a request cannot point apm at a host of its choosing.
 * `DELETE` is the same act in reverse: the entry leaves targets.json and the
 * transport is closed immediately.
 *
 * targets.json stays the store, so an approval survives a restart and a
 * hand-edited file keeps working exactly as before.
 */
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import {
  LOCAL_TARGET_ID,
  addTargetRequestSchema,
  syncAdoptRequestSchema,
  syncEnrollRequestSchema,
  type CommandResult,
  type CommandSpec,
  type ExecOptions,
  type ExecutionTarget,
  type Profile,
  type TargetCandidatesResponse,
  type TargetProfilesResponse,
  type TargetTransport,
  type TargetsResponse,
} from '@apm/shared';
import { ApiFailure, type AppContext } from '../context.js';
import { readConfiguredTargets, writeConfiguredTargets, type ConfiguredTarget } from './config.js';
import { findPeer, mergeCandidates, readTailnetPeers } from './discovery.js';
import { toApiFailure } from './errors.js';
import { createSshTransport } from './ssh.js';
import { adoptProfile, enrollProfile } from './sync.js';

export interface TargetRouteDeps {
  /**
   * Runs argv on the machine the daemon runs on — that is where discovery asks
   * `tailscale` about the tailnet. Defaults to the local transport, so it is
   * the same `shell: false` spawn every other command goes through.
   */
  exec?(spec: CommandSpec, options?: ExecOptions): Promise<CommandResult>;
  /** Transport for a newly approved target; tests substitute a fake. */
  createTransport?(target: ConfiguredTarget): TargetTransport;
}

export function registerTargetRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  deps: TargetRouteDeps = {},
): void {
  // Resolved per request rather than at registration time: the local transport
  // is the registry's, and a route table must not capture it before startup is
  // finished.
  const execOnHub: NonNullable<TargetRouteDeps['exec']> = (spec, options) =>
    deps.exec
      ? deps.exec(spec, options)
      : ctx.targets.transportFor(LOCAL_TARGET_ID).exec(spec, options);
  const createTransport = deps.createTransport ?? createSshTransport;

  app.get('/api/targets', async (): Promise<TargetsResponse> => ({ targets: ctx.targets.list() }));

  app.get('/api/targets/candidates', async (): Promise<TargetCandidatesResponse> => {
    const peers = await readTailnetPeers(execOnHub);
    return { candidates: mergeCandidates(peers, ctx.targets.list()) };
  });

  // Private in purpose (normal clients never need it), authenticated like all
  // API routes: the local SSH agent uses it so the daemon remains the sole
  // writer of profiles.json while importing an encrypted-transport bundle.
  app.post('/api/sync/enroll', async (req, reply): Promise<Profile> => {
    const parsed = syncEnrollRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new ApiFailure(400, 'bad-request', formatIssues(parsed.error));
    const profile = await enrollProfile(ctx, parsed.data);
    reply.code(201);
    return profile;
  });

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

  app.post<{ Params: { id: string } }>(
    '/api/targets/:id/sync-adopt',
    async (req, reply): Promise<Profile> => {
      const parsed = syncAdoptRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw new ApiFailure(400, 'bad-request', formatIssues(parsed.error));
      const profile = await adoptProfile(ctx, { targetId: req.params.id, ...parsed.data });
      reply.code(201);
      return profile;
    },
  );

  app.post('/api/targets', async (req, reply): Promise<ExecutionTarget> => {
    const parsed = addTargetRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new ApiFailure(400, 'bad-request', formatIssues(parsed.error));
    const { id, label, address } = parsed.data;

    const stored = readStored();
    if (ctx.targets.get(id) || stored.some((target) => target.id === id)) {
      throw new ApiFailure(409, 'target-exists', `A target named "${id}" already exists`);
    }

    // The tailnet is the only way in over the API: an address has to belong to
    // a machine this machine's tailnet just reported, so no request can point
    // apm at a host of its choosing. Hand-editing targets.json stays the
    // escape hatch for anything else.
    if (!findPeer(await readTailnetPeers(execOnHub), address)) {
      throw new ApiFailure(
        400,
        'not-a-tailnet-machine',
        `"${address}" is not a machine on this tailnet — targets are approved from the tailnet list`,
      );
    }

    // approved: true *is* the approval — this request is the human act, so
    // there is no second confirmation step and no unapproved limbo state.
    const entry: ConfiguredTarget = { id, label, transport: 'ssh', address, approved: true };
    // Persist first: a target the registry knows but the file does not would
    // silently disappear on the next restart.
    writeConfiguredTargets(ctx.config, [...stored, entry]);
    const transport = createTransport(entry);
    ctx.targets.addRemote(transport);

    reply.code(201);
    return { ...transport.target };
  });

  app.delete<{ Params: { id: string } }>('/api/targets/:id', async (req, reply) => {
    const { id } = req.params;
    if (id === LOCAL_TARGET_ID) {
      throw new ApiFailure(400, 'target-unsupported', 'The local target cannot be removed');
    }

    const stored = readStored();
    const remaining = stored.filter((target) => target.id !== id);
    const registered = ctx.targets.get(id) !== null;
    if (!registered && remaining.length === stored.length) {
      throw new ApiFailure(404, 'target-not-found', `No target "${id}"`);
    }

    if (remaining.length !== stored.length) writeConfiguredTargets(ctx.config, remaining);
    if (registered) {
      try {
        await ctx.targets.removeRemote(id);
      } catch (error: unknown) {
        throw toApiFailure(error);
      }
    }
    return reply.code(204).send();
  });

  /** A broken file is the operator's to fix; it must not read as "no targets". */
  function readStored(): ConfiguredTarget[] {
    try {
      return readConfiguredTargets(ctx.config);
    } catch (error: unknown) {
      throw new ApiFailure(
        500,
        'target-config-invalid',
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) =>
      issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
    )
    .join('; ');
}
