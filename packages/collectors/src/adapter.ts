import type {
  AdapterCapabilities,
  CollectResult,
  CredentialBundle,
  ProfileEnv,
  ProviderId,
  ProviderIdentity,
} from '@apm/shared';

/** Everything an adapter may use for one collection run. */
export interface CollectContext {
  /** Absolute path of the profile's provider home (CLAUDE_CONFIG_DIR / CODEX_HOME / CURSOR_CONFIG_DIR). */
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
  /**
   * Set for user-initiated refreshes. Adapters must skip their error
   * cooldowns and attempt a real fetch — the periodic scheduler never
   * sets it, so cooldowns still protect against background fetch spam.
   */
  force?: boolean;
  /**
   * When false the adapter must not rotate credentials: it skips token
   * refreshes and reports the auth failure instead. Set for sync replicas —
   * the owner machine is the sole background refresher.
   */
  allowRefresh?: boolean;
  /** Injectable fetch implementation for deterministic, network-free tests. */
  fetchImpl?: typeof fetch;
  /** Override the global statusline cache directory (tests only). */
  globalCacheDir?: string;
  /** Override the provider's default home when testing global-cache attribution. */
  defaultHome?: string;
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
  /** Env vars that bind a spawned process to the given home, split by reach. */
  env(home: string): ProfileEnv;
  /** Exact login command the user runs in a normal terminal for a fresh home. */
  loginCommand(home: string): string;
  /**
   * The login command as spawnable argv (no env prefix — combine with env()).
   * Provider-specific extra arguments may be appended by the caller.
   */
  loginArgv(): string[];
  /** Default global home for discovery (e.g. ~/.claude). */
  defaultHome(): string;
  /**
   * Cross-machine credential sync. Absent when the provider cannot sync
   * (Cursor: rotated tokens live in process memory only) — absence is the
   * capability check, so unsupported providers are excluded by construction.
   */
  credentialSync?: CredentialSyncSupport;
}

/** How a bundle may be applied — see writeBundle. */
export type WriteBundleMode = 'if-newer' | 'if-differs';

export interface CredentialSyncSupport {
  /** Absolute path of the credential file inside a profile home. */
  credentialFile(home: string): string;
  /** Current bundle (payload + mtime as rotatedAt); null without a usable file. */
  readBundle(home: string): Promise<CredentialBundle | null>;
  /**
   * Apply a bundle to the home's credential file, or report 'stale'.
   *
   * 'if-newer' (push path) applies only when bundle.rotatedAt is strictly
   * newer than the file's mtime, which keeps steady-state ordering and stops
   * echo loops. 'if-differs' (pull recovery path) applies whenever the payload
   * differs from the on-disk subset — the local credential is known bad there,
   * so timestamps must not block recovery. Applying sets the file's mtime to
   * rotatedAt, making the mtime the rotation clock on every machine.
   *
   * `guard.expectPayload` additionally requires the on-disk payload to still
   * equal that value (null: no usable file) inside the same snapshot the
   * write decision uses — the pull path's proof that the local credential is
   * still the one that failed.
   */
  writeBundle(
    home: string,
    bundle: CredentialBundle,
    mode: WriteBundleMode,
    guard?: { expectPayload: Record<string, unknown> | null },
  ): Promise<'applied' | 'stale'>;
}
