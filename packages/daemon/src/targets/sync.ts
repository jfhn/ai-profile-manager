/**
 * Credential sync between this machine and approved targets.
 *
 * Push-on-rotate: a poll watches every synced profile's credential file mtime
 * (the rotation clock — see collectors/credential-sync.ts) and pushes the
 * bundle to all approved remote targets when it moves, including once at
 * startup as missed-rotation catch-up. Receivers apply strictly-newer bundles
 * only, so re-offering known state is a no-op.
 *
 * Pull-on-auth-failure: when usage collection reports an auth failure for a
 * synced profile — owner or replica; a CLI may rotate tokens on any machine —
 * the service pulls candidate bundles from its peers, applies the newest
 * untried payload, and forces a usage refresh to validate it. Tried payloads
 * are remembered until a collection succeeds, so a future-dated stale peer is
 * tried once and then passed over instead of starving better candidates.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { adapters as defaultAdapters, stablePayloadKey } from '@apm/collectors';
import {
  isTransportError,
  type CredentialBundle,
  type ExecutionTarget,
  type Profile,
  type ProfileSync,
  type ProviderId,
  type TargetTransport,
} from '@apm/shared';
import type { DaemonConfig } from '../config.js';
import {
  ApiFailure,
  type EventBus,
  type ProfileService,
  type SyncService,
  type UsageService,
} from '../context.js';
import type { AdapterRegistry } from '../core/profiles.js';
import { toApiFailure } from './errors.js';
import type { TargetRegistry } from './registry.js';

const POLL_INTERVAL_MS = 15_000;
const PULL_COOLDOWN_MS = 4 * 60_000;

export function createSyncService(
  profiles: ProfileService,
  targets: TargetRegistry,
  usage: UsageService,
  events: EventBus,
  adapterRegistry: AdapterRegistry = defaultAdapters,
  options: { pullCooldownMs?: number } = {},
): SyncService {
  const pullCooldownMs = options.pullCooldownMs ?? PULL_COOLDOWN_MS;
  /** Rotation timestamp (ms) last pushed or applied per profile — the echo brake. */
  const syncedMtime = new Map<string, number>();
  /** Payload keys tried since the last successful collection, per profile. */
  const triedPayloads = new Map<string, Set<string>>();
  const pullCooldownUntil = new Map<string, number>();
  const pullInFlight = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  let unsubscribe: (() => void) | null = null;

  function peers(): Array<{ target: ExecutionTarget; transport: TargetTransport }> {
    const reachable = [];
    for (const target of targets.list()) {
      if (target.kind !== 'remote' || !target.approved) continue;
      if (!target.capabilities.includes('sync')) continue;
      reachable.push({ target, transport: targets.transportFor(target.id) });
    }
    return reachable;
  }

  async function tick(): Promise<void> {
    for (const profile of profiles.list()) {
      const sync = profile.sync;
      const credentialSync = adapterRegistry[profile.provider]?.credentialSync;
      if (!sync || !credentialSync) continue;
      try {
        const bundle = await credentialSync.readBundle(profile.home);
        if (!bundle) continue;
        const rotatedAtMs = Date.parse(bundle.rotatedAt);
        if (syncedMtime.get(profile.id) === rotatedAtMs) continue;
        syncedMtime.set(profile.id, rotatedAtMs);
        await pushToPeers(profile, sync, bundle);
      } catch (error) {
        logSync(`push sweep failed for profile ${profile.id}: ${message(error)}`);
      }
    }
  }

  async function pushToPeers(
    profile: Profile,
    sync: ProfileSync,
    bundle: CredentialBundle,
  ): Promise<void> {
    for (const { target, transport } of peers()) {
      try {
        await transport.syncPush(sync, bundle);
      } catch (error) {
        // Offline or not-yet-adopted peers are expected; the next rotation or
        // restart retries. A role conflict is a misconfiguration — say so.
        if (isTransportError(error) && error.code === 'sync-conflict') {
          logSync(
            `CONFLICT pushing ${profile.label} to target "${target.id}": both machines claim the owner role`,
          );
        } else {
          logSync(
            `push of ${profile.label} to target "${target.id}" dropped (${describeFailure(error)})`,
          );
        }
      }
    }
  }

  async function pull(profile: Profile, sync: ProfileSync): Promise<void> {
    const credentialSync = adapterRegistry[profile.provider]?.credentialSync;
    if (!credentialSync) return;
    pullCooldownUntil.set(profile.id, Date.now() + pullCooldownMs);

    const tried = triedPayloads.get(profile.id) ?? new Set<string>();
    triedPayloads.set(profile.id, tried);
    // The on-disk payload just failed against the provider — never re-apply it.
    const local = await credentialSync.readBundle(profile.home);
    const failedKey = local ? stablePayloadKey(local.payload) : null;
    if (failedKey) tried.add(failedKey);

    const candidates: CredentialBundle[] = [];
    for (const { target, transport } of peers()) {
      try {
        const bundle = await transport.syncPull(sync);
        if (bundle.provider === profile.provider) candidates.push(bundle);
      } catch (error) {
        logSync(
          `pull of ${profile.label} from target "${target.id}" skipped (${describeFailure(error)})`,
        );
      }
    }
    candidates.sort((left, right) => Date.parse(right.rotatedAt) - Date.parse(left.rotatedAt));

    for (const candidate of candidates) {
      const key = stablePayloadKey(candidate.payload);
      if (tried.has(key)) continue;
      tried.add(key);
      // The pull's authority to disregard timestamps rests on the local
      // credential still being the one that failed. If a CLI rotation or an
      // incoming push replaced it while peers were queried, that new state
      // may be valid — abort and let the next collection decide.
      const currentNow = await credentialSync.readBundle(profile.home);
      if ((currentNow ? stablePayloadKey(currentNow.payload) : null) !== failedKey) {
        logSync(`pull for ${profile.label} aborted: credentials changed while querying peers`);
        return;
      }
      const outcome = await credentialSync.writeBundle(profile.home, candidate, 'if-differs');
      if (outcome === 'applied') {
        syncedMtime.set(profile.id, Date.parse(candidate.rotatedAt));
        logSync(`applied pulled credentials for ${profile.label} (${candidate.rotatedAt})`);
        // Validate immediately: force skips the adapter's error cooldown, so
        // the stale auth snapshot is replaced without waiting it out.
        await usage.refresh(profile.id, { force: true }).catch(() => undefined);
      }
      // One candidate per round; the next auth failure advances to the next.
      return;
    }
  }

  return {
    tick,

    start() {
      if (timer) return;
      void tick().catch(() => undefined);
      timer = setInterval(() => void tick().catch(() => undefined), POLL_INTERVAL_MS);
      timer.unref();
      unsubscribe = events.subscribe((event) => {
        if (event.type !== 'usage-updated') return;
        const profile = profiles.get(event.profileId);
        if (!profile?.sync) return;
        if (event.snapshot.failureKind === null) {
          triedPayloads.delete(profile.id);
          pullCooldownUntil.delete(profile.id);
          return;
        }
        if (event.snapshot.failureKind !== 'auth') return;
        if (pullInFlight.has(profile.id)) return;
        if (Date.now() < (pullCooldownUntil.get(profile.id) ?? 0)) return;
        pullInFlight.add(profile.id);
        void pull(profile, profile.sync)
          .catch((error) => logSync(`pull for ${profile.label} failed: ${message(error)}`))
          .finally(() => pullInFlight.delete(profile.id));
      });
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}

/**
 * Adopt a remote profile as a local replica: enable sync on the owner through
 * its own daemon (the agent never writes the remote store), pull the first
 * bundle, and create a managed home plus replica profile here.
 */
export async function adoptProfile(
  ctx: {
    config: DaemonConfig;
    profiles: ProfileService;
    targets: TargetRegistry;
  },
  params: { targetId: string; provider: ProviderId; remoteProfileId: string; label?: string },
  adapterRegistry: AdapterRegistry = defaultAdapters,
): Promise<Profile> {
  const credentialSync = adapterRegistry[params.provider]?.credentialSync;
  if (!credentialSync) {
    throw new ApiFailure(
      400,
      'sync-unsupported',
      `Provider ${params.provider} does not support credential sync`,
    );
  }

  let transport: TargetTransport;
  let remote;
  try {
    transport = ctx.targets.transportFor(params.targetId);
    remote = await ctx.targets.resolveProfile(params.targetId, params.remoteProfileId);
  } catch (error: unknown) {
    throw toApiFailure(error);
  }
  if (transport.target.kind !== 'remote') {
    throw new ApiFailure(
      400,
      'target-unsupported',
      'Profiles are adopted from remote targets only',
    );
  }
  if (remote.provider !== params.provider) {
    throw new ApiFailure(
      409,
      'provider-mismatch',
      `Remote profile ${params.remoteProfileId} is a ${remote.provider} profile, not ${params.provider}`,
    );
  }
  if (remote.status !== 'active' || !remote.enabled) {
    throw new ApiFailure(
      409,
      'profile-unavailable',
      'The remote profile must be active and enabled',
    );
  }

  const syncId = await enableSyncOnOwner(transport, params.targetId, params.remoteProfileId);
  const sync: ProfileSync = { id: syncId, role: 'replica' };

  let bundle: CredentialBundle;
  try {
    bundle = await transport.syncPull(sync);
  } catch (error: unknown) {
    throw sanitizedSyncFailure(error, params.targetId);
  }
  if (bundle.provider !== params.provider) {
    throw new ApiFailure(
      502,
      'sync-provider-mismatch',
      `Target "${params.targetId}" answered with a ${bundle.provider} bundle for a ${params.provider} profile`,
    );
  }

  const home = path.join(ctx.config.homesDir, crypto.randomUUID());
  fs.mkdirSync(ctx.config.homesDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(home, { recursive: false, mode: 0o700 });
  try {
    await credentialSync.writeBundle(home, bundle, 'if-newer');
    return await ctx.profiles.createReplica({
      provider: params.provider,
      label: params.label ?? remote.label,
      home,
      sync,
    });
  } catch (error) {
    fs.rmSync(home, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Run `apm profile sync-enable` on the target so the owner-side store
 * mutation goes through the owner's own daemon. The command prints exactly
 * one JSON object; anything else is a failure.
 */
async function enableSyncOnOwner(
  transport: TargetTransport,
  targetId: string,
  remoteProfileId: string,
): Promise<string> {
  let result;
  try {
    result = await transport.exec(
      { argv: ['apm', 'profile', 'sync-enable', remoteProfileId] },
      { timeoutMs: 30_000 },
    );
  } catch (error: unknown) {
    throw toApiFailure(error);
  }
  if (result.exitCode !== 0) {
    // Remote stderr never reaches the response: a peer's output could carry
    // anything, and credential hygiene bars unvetted remote text from errors.
    throw new ApiFailure(
      502,
      'sync-enable-failed',
      `apm profile sync-enable exited with code ${result.exitCode ?? 'null'} on target "${targetId}" — run it there to see the reason`,
    );
  }
  const lastLine = result.stdout.trim().split('\n').at(-1) ?? '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(lastLine);
  } catch {
    parsed = null;
  }
  const syncId =
    parsed && typeof parsed === 'object' && 'syncId' in parsed
      ? (parsed as { syncId: unknown }).syncId
      : null;
  if (typeof syncId !== 'string' || !/^[0-9a-f-]{36}$/i.test(syncId)) {
    throw new ApiFailure(
      502,
      'sync-enable-failed',
      `apm profile sync-enable on target "${targetId}" returned no sync id`,
    );
  }
  return syncId;
}

function logSync(line: string): void {
  console.error(`apm sync: ${line}`);
}

/**
 * What may be said about a failed peer operation: transport errors carry
 * remote-agent text in their message, so only their code is repeated;
 * anything else was raised locally and its message is our own.
 */
function describeFailure(error: unknown): string {
  if (isTransportError(error)) return error.code;
  return message(error);
}

/**
 * Sync-operation failures answered to API callers name only the target and
 * the transport code — never the remote message, for the same reason.
 */
function sanitizedSyncFailure(error: unknown, targetId: string): ApiFailure {
  const mapped = toApiFailure(error);
  if (!isTransportError(error)) return mapped;
  return new ApiFailure(
    mapped.statusCode,
    mapped.code,
    `Credential sync with target "${targetId}" failed (${error.code})`,
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
