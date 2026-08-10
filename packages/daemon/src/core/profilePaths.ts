import crypto from 'node:crypto';
import path from 'node:path';

/**
 * Profile ids are opaque external values, not filesystem components. Hashing
 * gives every valid id a deterministic, fixed-size cache directory without
 * trimming, normalizing, or otherwise changing its identity.
 */
export function profileCacheDirectory(cacheRoot: string, profileId: string): string {
  const digest = crypto.createHash('sha256').update(profileId, 'utf8').digest('hex');
  return path.join(path.resolve(cacheRoot), `profile-${digest}`);
}
