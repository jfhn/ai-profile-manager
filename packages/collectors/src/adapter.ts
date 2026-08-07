import type {
  AdapterCapabilities,
  CollectResult,
  ProviderId,
  ProviderIdentity,
} from '@apm/shared';

/** Everything an adapter may use for one collection run. */
export interface CollectContext {
  /** Absolute path of the profile's provider home (CLAUDE_CONFIG_DIR / CODEX_HOME). */
  home: string;
  /**
   * Profile-private cache dir (created by the caller). Adapters store OAuth
   * usage caches / error cooldowns here — never inside the provider home.
   */
  cacheDir: string;
  /** Injected clock for tests; defaults to Date.now(). */
  now?: number;
  /**
   * When false the adapter must stay on local files only (read-only
   * discovery mode). Network fetches are opt-in per call.
   */
  allowNetwork: boolean;
}

/**
 * A provider adapter. All methods must be non-throwing in the sense that
 * provider-side breakage (malformed files, network failure, revoked auth)
 * is reported inside the result — a broken adapter must never take down the
 * daemon.
 */
export interface ProviderAdapter {
  provider: ProviderId;
  displayName: string;
  capabilities: AdapterCapabilities;
  /** True when the home contains usable credentials. Local files only. */
  hasCredentials(home: string): boolean;
  /** Resolve the logged-in identity from local files; null when unknown. */
  detectIdentity(home: string): ProviderIdentity | null;
  /** Collect a usage snapshot. Never throws; failures land in result.error. */
  collectUsage(ctx: CollectContext): Promise<CollectResult>;
  /** Env vars that bind a spawned process tree to the given home. */
  env(home: string): Record<string, string>;
  /** Exact login command the user runs in a normal terminal for a fresh home. */
  loginCommand(home: string): string;
  /** Default global home for discovery (e.g. ~/.claude). */
  defaultHome(): string;
}
