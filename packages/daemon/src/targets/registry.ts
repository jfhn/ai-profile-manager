/**
 * Target registry: the single place that maps a target id to its transport.
 *
 * The local target is always registered and is what an omitted/empty target
 * selection resolves to, so every existing local code path keeps working
 * unchanged. Remote targets must be registered explicitly and must carry an
 * approval flag — an unapproved machine never gets a command.
 */
import {
  LOCAL_TARGET_ID,
  TransportError,
  type ExecutionTarget,
  type TargetId,
  type TargetProfileSummary,
  type TargetTransport,
} from '@apm/shared';

export interface TargetRegistry {
  list(): ExecutionTarget[];
  /** Target descriptor; null when unknown. An omitted id means the local target. */
  get(id?: TargetId | null): ExecutionTarget | null;
  /**
   * Transport for a target. Throws TransportError('target-not-found') for an
   * unknown id and TransportError('target-not-approved') for a remote target
   * nobody approved on this machine.
   */
  transportFor(id?: TargetId | null): TargetTransport;
  /**
   * Register a remote target's transport (config loading, tests). The local
   * transport cannot be replaced.
   */
  register(transport: TargetTransport): void;
  /**
   * Approve a machine while the daemon runs: the target becomes selectable
   * immediately, without a restart. Refuses an id something already occupies —
   * an approval must never quietly repoint an existing target somewhere else.
   */
  addRemote(transport: TargetTransport): void;
  /**
   * Revoke a machine while the daemon runs: it disappears from the registry and
   * its transport is closed, so anything still in flight fails with that
   * transport's own 'closed' error rather than reaching a revoked machine.
   */
  removeRemote(id: TargetId): Promise<void>;
  /** Profiles as one target reports them — profile resolution is target-scoped. */
  profiles(id?: TargetId | null): Promise<TargetProfileSummary[]>;
  /** Resolve one profile id on a target, failing if that target does not have it. */
  resolveProfile(id: TargetId | null | undefined, profileId: string): Promise<TargetProfileSummary>;
  /** Release every remote connection; handles are the caller's business. */
  close(): Promise<void>;
}

export function createTargetRegistry(
  local: TargetTransport,
  remotes: TargetTransport[] = [],
): TargetRegistry {
  const transports = new Map<TargetId, TargetTransport>([[LOCAL_TARGET_ID, local]]);

  function transportFor(id?: TargetId | null): TargetTransport {
    const targetId = id ?? LOCAL_TARGET_ID;
    const transport = transports.get(targetId);
    if (!transport) {
      throw new TransportError('target-not-found', targetId, `No target "${targetId}"`);
    }
    const target = transport.target;
    if (target.kind !== 'local' && !target.approved) {
      throw new TransportError(
        'target-not-approved',
        targetId,
        `Target "${targetId}" is not approved on this machine`,
      );
    }
    return transport;
  }

  const registry: TargetRegistry = {
    list: () => [...transports.values()].map((transport) => ({ ...transport.target })),

    get(id) {
      const transport = transports.get(id ?? LOCAL_TARGET_ID);
      return transport ? { ...transport.target } : null;
    },

    transportFor,

    register(transport) {
      const id = transport.target.id;
      if (id === LOCAL_TARGET_ID) {
        throw new TransportError('target-not-approved', id, 'The local target cannot be replaced');
      }
      transports.set(id, transport);
    },

    addRemote(transport) {
      const id = transport.target.id;
      if (transports.has(id)) {
        // Callers check first and answer with a proper API error; this is the
        // invariant underneath them.
        throw new Error(`Target "${id}" is already registered`);
      }
      registry.register(transport);
    },

    async removeRemote(id) {
      if (id === LOCAL_TARGET_ID) {
        throw new TransportError('target-not-approved', id, 'The local target cannot be removed');
      }
      const transport = transports.get(id);
      if (!transport) {
        throw new TransportError('target-not-found', id, `No target "${id}"`);
      }
      transports.delete(id);
      await transport.close();
    },

    profiles: (id) => transportFor(id).profiles(),

    async resolveProfile(id, profileId) {
      const targetId = id ?? LOCAL_TARGET_ID;
      const profiles = await transportFor(targetId).profiles();
      const profile = profiles.find((candidate) => candidate.id === profileId);
      if (!profile) {
        throw new TransportError(
          'profile-not-found',
          targetId,
          `No profile ${profileId} on target "${targetId}"`,
        );
      }
      return profile;
    },

    async close() {
      for (const transport of transports.values()) await transport.close();
    },
  };

  for (const transport of remotes) registry.register(transport);
  return registry;
}
