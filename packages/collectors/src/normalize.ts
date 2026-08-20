import type { UsageWindow } from '@apm/shared';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function jwtClaims(token: string | null): Record<string, unknown> | null {
  if (!token) return null;
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const decoded = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
      'utf8',
    );
    const claims: unknown = JSON.parse(decoded);
    return isRecord(claims) ? claims : null;
  } catch {
    return null;
  }
}

export function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function firstValue(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null && record[key] !== '') {
      return record[key];
    }
  }
  return null;
}

export function firstNumber(
  record: Record<string, unknown>,
  keys: readonly string[],
): number | null {
  for (const key of keys) {
    const value = toNumber(record[key]);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

export function clampPercent(value: number | null): number | null {
  return value === null ? null : Math.max(0, Math.min(100, value));
}

export function safeReason(value: unknown): string {
  return (
    (readString(value) ?? 'Unavailable')
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, '[redacted credential]')
      .replace(/WorkosCursorSessionToken=([^;\s]+)/gi, 'WorkosCursorSessionToken=[redacted]')
      .replace(/auth=([^;\s]+)/gi, 'auth=[redacted]')
      .replace(
        /(access_?token|refresh_?token|authCookie|Authorization|Cookie)["':=\s]+[^,\s}]+/gi,
        'credential=[redacted]',
      )
      // A JWT carries the session on its own, so an unlabelled one in an error
      // message is as sensitive as a labelled one.
      .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 180)
  );
}

export function normalizeTimestamp(value: unknown): string | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value)
        ? Number(value)
        : null;
  const parsed =
    numeric === null
      ? Date.parse(String(value))
      : numeric > 100_000_000_000
        ? numeric
        : numeric * 1000;
  const date = new Date(parsed);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : null;
}

export function normalizeQuotaWindow(
  input: unknown,
  nowMs: number,
): Omit<UsageWindow, 'id' | 'label'> | null {
  if (!isRecord(input)) {
    return null;
  }
  let usedPercent = firstNumber(input, [
    'used_percent',
    'used_percentage',
    'usedPercent',
    'usagePercent',
    'utilization',
    'percent_used',
    'used',
  ]);
  let remainingPercent = firstNumber(input, [
    'remaining_percent',
    'remaining_percentage',
    'remainingPercent',
    'percentRemaining',
    'percent_remaining',
    'remaining',
  ]);
  if (remainingPercent === null && usedPercent !== null) {
    remainingPercent = 100 - usedPercent;
  }
  if (usedPercent === null && remainingPercent !== null) {
    usedPercent = 100 - remainingPercent;
  }
  const resetAt = normalizeTimestamp(
    firstValue(input, [
      'reset_at',
      'resetAt',
      'resets_at',
      'resetsAt',
      'resetTimeIso',
      'reset_time_iso',
      'window_reset_at',
      'next_reset_at',
    ]),
  );
  const resetMs = Date.parse(resetAt ?? '');
  if (Number.isFinite(resetMs) && resetMs <= nowMs && remainingPercent !== null) {
    usedPercent = 0;
    remainingPercent = 100;
  }
  return {
    usedPercent: clampPercent(usedPercent),
    remainingPercent: clampPercent(remainingPercent),
    resetAt: Number.isFinite(resetMs) && resetMs > nowMs ? resetAt : null,
  };
}

export function makeQuotaWindow(
  id: string,
  label: string,
  input: unknown,
  nowMs: number,
): UsageWindow | null {
  const normalized = normalizeQuotaWindow(input, nowMs);
  return normalized && normalized.remainingPercent !== null ? { id, label, ...normalized } : null;
}

export function rateLimitRoot(data: unknown): unknown {
  if (!isRecord(data)) {
    return null;
  }
  return (
    data.rate_limits ?? data.rateLimits ?? data.usage ?? data.oauth_usage ?? data.oauthUsage ?? data
  );
}

export function firstWindowValue(root: unknown, keys: readonly string[]): unknown {
  if (!isRecord(root)) {
    return null;
  }
  for (const key of keys) {
    if (root[key]) {
      return root[key];
    }
  }
  return null;
}

export function hasFutureReset(windows: readonly UsageWindow[], nowMs: number): boolean {
  return windows.some((window) => {
    const resetMs = Date.parse(window.resetAt ?? '');
    return Number.isFinite(resetMs) && resetMs > nowMs;
  });
}

export function failureKind(
  reason: string | null | undefined,
): 'auth' | 'timeout' | 'rate-limited' | 'error' | null {
  const text = (reason ?? '').toLowerCase();
  if (!text) return null;
  if (text.includes('timeout') || text.includes('timed out')) return 'timeout';
  if (text.includes('429') || text.includes('rate')) return 'rate-limited';
  if (
    text.includes('credential') ||
    text.includes('token') ||
    text.includes('unauthorized') ||
    text.includes('401') ||
    text.includes('403')
  )
    return 'auth';
  return 'error';
}
