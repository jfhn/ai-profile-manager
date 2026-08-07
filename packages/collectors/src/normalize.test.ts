import { describe, expect, it } from 'vitest';
import { clampPercent, failureKind, makeQuotaWindow, normalizeTimestamp, safeReason } from './normalize.js';

describe('normalize helpers', () => {
  it('normalizes Unix seconds and millisecond timestamps', () => {
    expect(normalizeTimestamp(1_700_000_000)).toBe('2023-11-14T22:13:20.000Z');
    expect(normalizeTimestamp('1700000000000')).toBe('2023-11-14T22:13:20.000Z');
    expect(normalizeTimestamp('not-a-date')).toBeNull();
  });

  it('clamps usage and treats a past reset as a fresh window', () => {
    const now = Date.parse('2025-01-02T00:00:00Z');
    const window = makeQuotaWindow('weekly', '7d', { used_percent: 140, reset_at: '2025-01-01T00:00:00Z' }, now);
    expect(clampPercent(-1)).toBe(0);
    expect(window).toMatchObject({ usedPercent: 0, remainingPercent: 100, resetAt: null });
  });

  it('redacts credential-shaped errors and classifies failures', () => {
    expect(safeReason('Bearer abc.def_123 auth=secret accessToken: nope')).not.toContain('secret');
    expect(failureKind('request timed out')).toBe('timeout');
    expect(failureKind('HTTP 429')).toBe('rate-limited');
    expect(failureKind('HTTP 401 token rejected')).toBe('auth');
    expect(failureKind('disk failed')).toBe('error');
  });
});
