import type { ProviderId } from './provider.js';
import type { TargetId } from './target.js';
import type { EndpointProtocol, EndpointScope } from './transport.js';

/**
 * Managed T3 Code instances: detached server processes (no PTY), one port +
 * base dir each, spawned with the selected profiles' env. Their UI is their
 * own web app — the dashboard only links to it.
 *
 * An instance belongs to exactly one execution target. Local instances keep
 * their loopback URL; an instance on a remote target is reached through that
 * target's transport endpoint, which is the only thing that knows the URL.
 */

export type T3InstanceStatus = 'stopped' | 'starting' | 'running' | 'unhealthy' | 'exited';

/**
 * How one running instance is reached, exactly as its transport reported it.
 * Never assembled by hand: a remote instance is behind a forward or the
 * target's own address, and only the endpoint knows which.
 */
export interface T3Endpoint {
  /**
   * 'loopback' — the instance runs on this machine (local target only).
   * 'forwarded' — the daemon's machine forwards to the target, so the URL
   *   works in a browser on *this* machine only.
   * 'published' — the target's own address, reachable from the trusted
   *   network; this is what another device needs.
   */
  scope: EndpointScope;
  protocol: EndpointProtocol;
  /** Port the instance listens on, on its own target. */
  port: number;
  /** Browser-reachable URL; null until the instance answers. */
  url: string | null;
}

export interface T3Instance {
  id: string;
  label: string;
  /** Target the instance runs on; LOCAL_TARGET_ID for the daemon's machine. */
  targetId: TargetId;
  /** Port the instance listens on, on its target. */
  port: number | null;
  /** Instance-private --base-dir on the target (T3 assumes one runtime per base dir). */
  baseDir: string;
  /** Profile bound per provider at launch; one profile per provider max. */
  profiles: Partial<Record<ProviderId, string>>;
  status: T3InstanceStatus;
  /** OS pid on the daemon's machine; always null for remote instances. */
  pid: number | null;
  /** The Open link, straight from the endpoint. Loopback only for local instances. */
  url: string | null;
  /** Endpoint as the transport reported it; null while the instance is stopped. */
  endpoint: T3Endpoint | null;
  /** Last health-check error, if unhealthy. */
  statusReason: string | null;
  createdAt: string;
}
