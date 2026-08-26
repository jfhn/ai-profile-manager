import { describe, expect, it } from 'vitest';
import { ROUTES } from './router.svelte';

describe('dashboard routes', () => {
  it('keeps the profile, session and target pages', () => {
    expect(ROUTES).toEqual(['/', '/sessions', '/tools', '/targets']);
  });
});
