/**
 * Shared machinery behind each adapter's `credentialSync` support.
 *
 * The credential file's mtime is the rotation clock: `readBundle` reports it
 * as `rotatedAt`, and `writeBundle` sets the file's mtime to the applied
 * bundle's `rotatedAt`. Re-offering an already-applied bundle therefore
 * compares equal and lands as 'stale' — no echo between machines.
 *
 * Writes guard against concurrent rotations the way the adapters' own refresh
 * writers do: the file is re-read immediately before the atomic rename, and
 * any change to its mtime or synced payload since the decision aborts the
 * write as 'stale'. The residual rename-vs-rename race is accepted; a lost
 * rotation surfaces as an auth failure and heals through pull-on-auth-failure
 * or, at worst, a re-login on the owner.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ProviderId } from '@apm/shared';
import type { CredentialSyncSupport, WriteBundleMode } from './adapter.js';
import { statOrNull } from './bounded.js';
import { isRecord } from './normalize.js';

const READ_RETRIES = 3;

export interface CredentialSyncOptions {
  provider: ProviderId;
  /** Credential file name inside the profile home (e.g. '.credentials.json'). */
  fileName: string;
  /**
   * The synced subset of a parsed credential file; null when the record does
   * not carry usable credentials. Also validates incoming bundle payloads.
   */
  extract(record: Record<string, unknown>): Record<string, unknown> | null;
  /** Merge a synced subset into the current file, preserving every other field. */
  merge(
    current: Record<string, unknown>,
    payload: Record<string, unknown>,
  ): Record<string, unknown>;
}

/**
 * Deterministic identity of a payload (sorted keys, recursively), used to
 * compare payloads across machines and to remember tried pull candidates.
 */
export function stablePayloadKey(payload: unknown): string {
  return JSON.stringify(sortKeys(payload));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isRecord(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) sorted[key] = sortKeys(value[key]);
  return sorted;
}

export function createCredentialSync(options: CredentialSyncOptions): CredentialSyncSupport {
  const file = (home: string) => path.join(home, options.fileName);

  /**
   * A consistent (payload, mtime) snapshot of the credential file: stat,
   * read, stat again, retry when the mtime moved mid-read so a bundle can
   * never mix two rotations. Null when the file is missing or unusable.
   */
  async function snapshot(home: string): Promise<{
    record: Record<string, unknown>;
    payload: Record<string, unknown>;
    mtimeMs: number;
  } | null> {
    for (let attempt = 0; attempt < READ_RETRIES; attempt += 1) {
      const before = await statOrNull(file(home));
      if (!before) return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(await fsp.readFile(file(home), 'utf8'));
      } catch {
        return null;
      }
      const after = await statOrNull(file(home));
      if (!after || Number(after.mtimeMs) !== Number(before.mtimeMs)) continue;
      const record = isRecord(parsed) ? parsed : {};
      const payload = options.extract(record);
      if (!payload) return null;
      // toISOString truncates to whole milliseconds; truncate here too so the
      // mtime survives a rotatedAt round-trip unchanged.
      return { record, payload, mtimeMs: Math.trunc(Number(before.mtimeMs)) };
    }
    return null;
  }

  return {
    credentialFile: file,

    async readBundle(home) {
      const current = await snapshot(home);
      if (!current) return null;
      return {
        provider: options.provider,
        rotatedAt: new Date(current.mtimeMs).toISOString(),
        payload: current.payload,
      };
    },

    async writeBundle(home, bundle, mode, guard) {
      const incoming = options.extract(bundle.payload);
      if (!incoming) {
        throw new Error(`Unusable ${options.provider} credential bundle payload`);
      }
      const rotatedAtMs = Date.parse(bundle.rotatedAt);
      if (!Number.isFinite(rotatedAtMs)) {
        throw new Error(`Invalid credential bundle rotatedAt: ${bundle.rotatedAt}`);
      }

      const current = await snapshot(home);
      if (guard) {
        const currentKey = current ? stablePayloadKey(current.payload) : null;
        const expectedKey =
          guard.expectPayload === null ? null : stablePayloadKey(guard.expectPayload);
        if (currentKey !== expectedKey) return 'stale';
      }
      if (current && !decides(mode, rotatedAtMs, current, incoming)) return 'stale';

      const target = file(home);
      const merged = options.merge(current?.record ?? {}, incoming);
      const temp = `${target}.${process.pid}.sync.tmp`;
      try {
        await fsp.writeFile(temp, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
        await fsp.chmod(temp, 0o600);
        // rotatedAt goes onto the temp file so the rename makes payload and
        // rotation timestamp visible in one atomic step — a concurrent poll
        // must never see the new payload under a fresh mtime and re-push it.
        const rotated = new Date(rotatedAtMs);
        await fsp.utimes(temp, rotated, rotated);
        // Re-check right before the rename: a CLI or adapter refresh that
        // landed since the decision wins, exactly like the adapters' own
        // rotation-conflict guards.
        const recheck = await snapshot(home);
        if (
          (current === null) !== (recheck === null) ||
          (current &&
            recheck &&
            (recheck.mtimeMs !== current.mtimeMs ||
              stablePayloadKey(recheck.payload) !== stablePayloadKey(current.payload)))
        ) {
          await fsp.rm(temp, { force: true });
          return 'stale';
        }
        await fsp.rename(temp, target);
        return 'applied';
      } catch (error) {
        await fsp.rm(temp, { force: true }).catch(() => undefined);
        throw error;
      }
    },
  };

  function decides(
    mode: WriteBundleMode,
    rotatedAtMs: number,
    current: { payload: Record<string, unknown>; mtimeMs: number },
    incoming: Record<string, unknown>,
  ): boolean {
    if (mode === 'if-newer') return rotatedAtMs > current.mtimeMs;
    return stablePayloadKey(incoming) !== stablePayloadKey(current.payload);
  }
}
