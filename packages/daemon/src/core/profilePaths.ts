import crypto from 'node:crypto';
import path from 'node:path';

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
