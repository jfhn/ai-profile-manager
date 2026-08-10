import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { profileCacheDirectory } from './profilePaths.js';

describe('profileCacheDirectory', () => {
  it('does not interpret an opaque profile id as path syntax', () => {
    const root = '/var/lib/apm/cache';
    const result = profileCacheDirectory(root, ' ../work/個人 ! ');

    expect(path.dirname(result)).toBe(root);
    expect(path.basename(result)).toMatch(/^profile-[a-f0-9]{64}$/);
    expect(result).not.toContain('個人');
  });

  it('keeps exact edge whitespace significant', () => {
    expect(profileCacheDirectory('/cache', 'work')).not.toBe(
      profileCacheDirectory('/cache', ' work '),
    );
  });
});
