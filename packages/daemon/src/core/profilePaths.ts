import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ProviderId } from '@apm/shared';
import type { DaemonConfig } from '../config.js';

const CODEX_CONTROL_SOCKET = path.join('app-server-control', 'app-server-control.sock');
const MAX_UNIX_SOCKET_PATH_BYTES = 103;

export function codexControlSocketFits(home: string): boolean {
  return (
    process.platform === 'win32' ||
    Buffer.byteLength(path.join(home, CODEX_CONTROL_SOCKET)) <= MAX_UNIX_SOCKET_PATH_BYTES
  );
}

export function createManagedHome(
  config: DaemonConfig,
  provider: ProviderId,
): { id: string; home: string } {
  fs.mkdirSync(config.homesDir, { recursive: true, mode: 0o700 });
  if (provider === 'codex') {
    const candidate = path.join(fs.realpathSync(config.homesDir), '0'.repeat(16));
    if (!codexControlSocketFits(candidate)) {
      throw new Error(`Codex home path is too long: ${candidate}`);
    }
  }
  for (;;) {
    const id = crypto.randomUUID();
    const name = provider === 'codex' ? id.replaceAll('-', '').slice(0, 16) : id;
    const home = path.join(config.homesDir, name);
    try {
      fs.mkdirSync(home, { mode: 0o700 });
      return { id, home };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}

/**
 * Profile ids are opaque external values, not filesystem components. Hashing
 * gives every valid id a deterministic, fixed-size directory without
 * trimming, normalizing, or otherwise changing its identity.
 */
function profileDirectory(root: string, profileId: string): string {
  const digest = crypto.createHash('sha256').update(profileId, 'utf8').digest('hex');
  return path.join(path.resolve(root), `profile-${digest}`);
}

export function profileCacheDirectory(cacheRoot: string, profileId: string): string {
  return profileDirectory(cacheRoot, profileId);
}

/** Holds the generated provider-CLI shims that sessions get on their PATH. */
export function profileShimDirectory(shimRoot: string, profileId: string): string {
  return profileDirectory(shimRoot, profileId);
}
