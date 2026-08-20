import type { ProviderId } from './provider.js';
import type { ProfileStatus } from './profile.js';

/**
 * Execution targets: the machines apm is allowed to run work on.
 *
 * A target is identity + capabilities only. *How* bytes reach it is the
 * transport's business (see transport.ts), so no concrete transport —
 * Tailscale, SSH, anything else — appears in this model. The machine the
 * daemon itself runs on is always present as LOCAL_TARGET_ID and stays the
 * default everywhere: an omitted target always means "local".
 */

/** Stable target handle, e.g. what `apm run --target <id>` takes. */
export type TargetId = string;

/** The machine the daemon runs on. Always present, always approved. */
export const LOCAL_TARGET_ID = 'local';

export type TargetKind = 'local' | 'remote';

/**
 * What a target can actually do. Transports may implement a subset, so
 * consumers must check `capabilities` (or `TargetTransport.supports`) before
 * using one instead of assuming every target behaves like the local machine.
 */
export const TARGET_CAPABILITIES = ['exec', 'pty', 'signal', 'profiles', 'sync'] as const;
export type TargetCapability = (typeof TARGET_CAPABILITIES)[number];

/** Last known reachability. 'unknown' until a transport probed the target. */
export type TargetStatus = 'online' | 'offline' | 'unknown';

/** Everything that identifies the machine — never anything secret. */
export interface TargetIdentity {
  /** Hostname as the target reports it; informational only. */
  hostname: string | null;
  /**
   * Opaque, transport-specific address (tailnet name, ssh host, ...). It is
   * handed to a transport as a structured value and never interpolated into
   * a shell command.
   */
  address: string | null;
  /** Stable key the transport pins the machine to, when it has one. */
  fingerprint: string | null;
}

export interface ExecutionTarget {
  /** Stable across daemon restarts; the local machine is always LOCAL_TARGET_ID. */
  id: TargetId;
  label: string;
  kind: TargetKind;
  /** Transport implementation id ('local', 'tailscale', ...) — diagnostics only. */
  transport: string;
  identity: TargetIdentity;
  capabilities: TargetCapability[];
  /**
   * Remote targets run nothing until a human approved them on this machine.
   * The local target is approved by definition.
   */
  approved: boolean;
  status: TargetStatus;
}

export function hasCapability(target: ExecutionTarget, capability: TargetCapability): boolean {
  return target.capabilities.includes(capability);
}

/**
 * A machine apm *could* be pointed at — never one it may run anything on.
 *
 * Candidates come from the tailnet the daemon's own machine is part of, and
 * they are display-only: a candidate becomes an execution target when a human
 * approves that one machine, which is what creates the target entry. Nothing
 * here is a transport and nothing here is addressable until then.
 */
export interface TargetCandidate {
  /** Hostname as the tailnet reports it. */
  hostname: string;
  /** MagicDNS name without its trailing dot; empty when the tailnet has none. */
  dnsName: string;
  /** What the target's address would be: the MagicDNS name, else the hostname. */
  address: string;
  /** Last state the tailnet reported for the machine. */
  online: boolean;
  /** OS the machine reports ('linux', 'macOS', …); null when it reports none. */
  os: string | null;
  /** Id of the registered target already using this machine, else null. */
  registeredTargetId: TargetId | null;
  /**
   * Target id to offer if this machine is approved: the hostname reduced to
   * what a target id may contain, and free at the time of the scan. Empty when
   * the hostname leaves nothing usable — the user then names it themselves.
   */
  suggestedId: string;
}

/**
 * A profile as one target reports it. Deliberately without `home` and without
 * any credential material: provider credentials stay on the machine that owns
 * them, so profile resolution is always scoped to a target.
 */
export interface TargetProfileSummary {
  id: string;
  provider: ProviderId;
  label: string;
  status: ProfileStatus;
  enabled: boolean;
}
