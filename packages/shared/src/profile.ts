import type { ProviderId, ProviderIdentity } from './provider.js';

/**
 * A profile binds a provider to one config home (CLAUDE_CONFIG_DIR /
 * CODEX_HOME / CURSOR_CONFIG_DIR). Credentials live only inside that home on
 * disk — never in the profile store, never in API responses.
 */

export type ProfileStatus = 'pending' | 'active' | 'error';

/** How the home directory came to be. */
export type ProfileHomeKind =
  /** Created by apm under its data dir (wizard flow). Safe to purge. */
  | 'managed'
  /** Pre-existing directory adopted via discovery (e.g. ~/.claude). Read-only to apm. */
  | 'external';

/**
 * Cross-machine membership of a synced credential set. The sync id is the
 * shared identity; profile ids stay machine-scoped. Only the owner's daemon
 * background-refreshes the credentials — replicas collect usage with refresh
 * suppressed and pull rotated tokens from their peers.
 */
export interface ProfileSync {
  /** UUID shared by every profile in the sync group. */
  id: string;
  role: 'owner' | 'replica';
}

export interface Profile {
  /** Opaque id: exact spelling is significant; never interpret it as a path. */
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
  /** Cross-machine credential sync membership; null for unsynced profiles. */
  sync: ProfileSync | null;
  /** ISO timestamp. */
  createdAt: string;
}

/**
 * The profile selected for new work in each provider. An absent entry means
 * the user has not selected a default; consumers must not guess one.
 */
export type DefaultProfileIds = Partial<Record<ProviderId, string>>;
