import type { ProviderId, ProviderIdentity } from './provider.js';

/**
 * A profile binds a provider to one config home (CLAUDE_CONFIG_DIR /
 * CODEX_HOME). Credentials live only inside that home on disk — never in the
 * profile store, never in API responses.
 */

export type ProfileStatus = 'pending' | 'active' | 'error';

/** How the home directory came to be. */
export type ProfileHomeKind =
  /** Created by apm under its data dir (wizard flow). Safe to purge. */
  | 'managed'
  /** Pre-existing directory adopted via discovery (e.g. ~/.claude). Read-only to apm. */
  | 'external';

export interface Profile {
  id: string;
  provider: ProviderId;
  /** Display name, unique per provider (so "work" can exist for both claude and codex). */
  label: string;
  /** Absolute path to the provider config home. */
  home: string;
  homeKind: ProfileHomeKind;
  identity: ProviderIdentity | null;
  status: ProfileStatus;
  /** Human-readable reason when status === 'error'. */
  statusReason: string | null;
  /** Disabled profiles are kept but not refreshed and not offered for launch. */
  enabled: boolean;
  /** ISO timestamp. */
  createdAt: string;
}
