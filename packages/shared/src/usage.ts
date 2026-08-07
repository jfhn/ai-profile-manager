/**
 * Provider-independent usage normalization. Adapters map whatever the
 * provider exposes into UsageWindow[]; missing data is null, never guessed.
 */

export interface UsageWindow {
  /** Stable id: 'five_hour' | 'weekly' | 'monthly' | adapter-specific. */
  id: string;
  /** Short display label: '5h', '7d', ... */
  label: string;
  /** 0..100, null when the provider doesn't expose it. */
  usedPercent: number | null;
  /** 0..100. Adapters guarantee used+remaining ≈ 100 when both present. */
  remainingPercent: number | null;
  /** ISO timestamp of the next reset; null when unknown or already past. */
  resetAt: string | null;
}

/**
 * Where the data in a snapshot came from, honestly:
 * - 'live'            fetched/read fresh this refresh
 * - 'cache'           served from a recent cache within its TTL
 * - 'stale-cache'     cache older than the freshness horizon; shown with a warning
 * - 'cooldown'        a previous fetch failed recently; waiting before retrying
 * - 'error'           nothing usable, see `error`
 */
export type CacheStatus = 'live' | 'cache' | 'stale-cache' | 'cooldown' | 'error';

export interface UsageSnapshot {
  profileId: string;
  windows: UsageWindow[];
  /** ISO timestamp of when this snapshot was produced. */
  fetchedAt: string;
  /** Human-readable data source, e.g. "codex session rate_limits". */
  source: string;
  cacheStatus: CacheStatus;
  /** ISO timestamp of the underlying data (may predate fetchedAt for caches). */
  dataUpdatedAt: string | null;
  stale: boolean;
  staleReason: string | null;
  /** Failure classification for UI badges. */
  failureKind: 'auth' | 'timeout' | 'rate-limited' | 'error' | null;
  /** Credential-redacted error message; null when data is usable. */
  error: string | null;
  /** Plan label reported alongside usage (e.g. codex plan_type), if any. */
  planType: string | null;
  /** Seconds until a cooled-down source may be retried. */
  retryAfterSeconds: number | null;
}

/** Result of one adapter collection run; the daemon stamps profileId/fetchedAt. */
export type CollectResult = Omit<UsageSnapshot, 'profileId' | 'fetchedAt'>;
