import type { ProviderId } from './provider.js';

/**
 * Managed T3 Code instances: detached server processes (no PTY), one port +
 * base dir each, spawned with the selected profiles' env. Their UI is their
 * own web app — the dashboard only links to it.
 */

export type T3InstanceStatus = 'stopped' | 'starting' | 'running' | 'unhealthy' | 'exited';

export interface T3Instance {
  id: string;
  label: string;
  /** Daemon-assigned port the instance listens on. */
  port: number | null;
  /** Instance-private --base-dir (T3 assumes a single runtime per base dir). */
  baseDir: string;
  /** Profile bound per provider at launch; one profile per provider max. */
  profiles: Partial<Record<ProviderId, string>>;
  status: T3InstanceStatus;
  pid: number | null;
  /** http://127.0.0.1:<port> when running. */
  url: string | null;
  /** Last health-check error, if unhealthy. */
  statusReason: string | null;
  createdAt: string;
}
