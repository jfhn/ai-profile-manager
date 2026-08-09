/**
 * Tailscale-backed service endpoints for a remote target.
 *
 * A managed T3 instance listens on the target's own loopback address; nothing
 * about it is reachable from anywhere else. This module publishes that port to
 * the tailnet by running `tailscale serve` **on the target**, through whatever
 * exec channel the transport already has — there is no second connection, no
 * shell string, and no value interpolated into a command line.
 *
 * The published URL is HTTPS on the machine's own MagicDNS name, so:
 *   - a browser on any other tailnet device can open it,
 *   - it is a secure context, which the T3 web app's pairing flow needs,
 *   - and it is reachable inside the tailnet only. Funnel is never enabled,
 *     and an endpoint that somehow ended up funnelled is torn down instead of
 *     handed out.
 *
 * `close()` removes the serve configuration again, which is also the
 * revocation path documented in docs/T3-REMOTE.md.
 */
import {
  TransportError,
  type CommandResult,
  type CommandSpec,
  type EndpointHandle,
  type EndpointHealth,
  type EndpointRequest,
  type ServiceEndpoint,
  type TargetId,
} from '@apm/shared';

/** First HTTPS port offered to the tailnet; 443 is left to whatever owns it. */
export const TAILSCALE_HTTPS_PORT_BASE = 8443;
/** First loopback port asked of the service on the target. */
export const TAILSCALE_SERVICE_PORT_BASE = 4800;
const PORT_SCAN_LIMIT = 200;
const DEFAULT_HEALTH_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
/** `tailscale` calls are local to the target and should never hang a start. */
const COMMAND_TIMEOUT_MS = 15_000;
/** Short: this only decides whether a leftover listener is worth reclaiming. */
const RECLAIM_PROBE_TIMEOUT_MS = 2_000;

export interface TailscaleEndpointDeps {
  targetId: TargetId;
  /** The transport's own exec channel — argv in, CommandResult out. */
  exec(spec: CommandSpec, options?: { timeoutMs?: number }): Promise<CommandResult>;
  /** Probe the published URL from the machine running the daemon. */
  probe(url: string, timeoutMs?: number): Promise<boolean>;
  /** Ports this transport already handed out, so two endpoints never collide. */
  reserved: Set<number>;
  pollIntervalMs?: number;
}

// ---- pure helpers (unit-tested directly) ------------------------------------

/** `tailscale serve --bg --https=<https> http://127.0.0.1:<service>`. */
export function serveArgv(httpsPort: number, servicePort: number): string[] {
  // Only http://127.0.0.1 is accepted as a proxy target, which is exactly what
  // a service bound to the target's loopback address is.
  return ['tailscale', 'serve', '--bg', `--https=${httpsPort}`, `http://127.0.0.1:${servicePort}`];
}

/** The same invocation with `off` appended, which is how serve is undone. */
export function serveOffArgv(httpsPort: number, servicePort: number): string[] {
  return ['tailscale', 'serve', `--https=${httpsPort}`, `http://127.0.0.1:${servicePort}`, 'off'];
}

/** The target's own MagicDNS name from `tailscale status --json`. */
export function parseSelfDnsName(stdout: string): string | null {
  const self = parseJson(stdout)?.['Self'];
  const name = isRecord(self) ? self['DNSName'] : undefined;
  if (typeof name !== 'string' || name.trim() === '') return null;
  return name.trim().replace(/\.$/, '');
}

/**
 * HTTPS/TCP ports `tailscale serve status --json` already has a handler for.
 * Its keys are `host:port`, so only the trailing port matters — and an empty
 * or unparsable config simply means nothing is served yet.
 */
export function parseServedPorts(stdout: string): number[] {
  return [...new Set(parseServeEntries(stdout).map((entry) => entry.httpsPort))].sort(
    (a, b) => a - b,
  );
}

/** One published listener and the loopback port it proxies to, when it has one. */
export interface ServeEntry {
  httpsPort: number;
  /** Port behind `http://127.0.0.1:<port>`; null for anything else (files, TCP). */
  backendPort: number | null;
}

/**
 * The target's serve configuration as listener/backend pairs.
 *
 * The backends matter as much as the listeners: a service port that something
 * is already proxied to is a port a new instance must not try to bind, which
 * is exactly how a restart used to collide with a process that outlived it.
 */
export function parseServeEntries(stdout: string): ServeEntry[] {
  const config = parseJson(stdout);
  if (!config) return [];
  const entries = new Map<number, ServeEntry>();

  const web = config['Web'];
  if (isRecord(web)) {
    for (const [key, value] of Object.entries(web)) {
      const httpsPort = portOfKey(key);
      if (httpsPort === null) continue;
      entries.set(httpsPort, { httpsPort, backendPort: backendOf(value) });
    }
  }
  // TCP forwards have no proxy target we can read; they still own their port.
  const tcp = config['TCP'];
  if (isRecord(tcp)) {
    for (const key of Object.keys(tcp)) {
      const httpsPort = portOfKey(key);
      if (httpsPort === null || entries.has(httpsPort)) continue;
      entries.set(httpsPort, { httpsPort, backendPort: null });
    }
  }
  return [...entries.values()].sort((a, b) => a.httpsPort - b.httpsPort);
}

/** `{ Handlers: { '/': { Proxy: 'http://127.0.0.1:4800' } } }` -> 4800. */
function backendOf(value: unknown): number | null {
  if (!isRecord(value)) return null;
  const handlers = value['Handlers'];
  if (!isRecord(handlers)) return null;
  for (const handler of Object.values(handlers)) {
    if (!isRecord(handler)) continue;
    const proxy = handler['Proxy'];
    if (typeof proxy !== 'string') continue;
    const match = /^https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)/.exec(proxy);
    if (match?.[1]) return Number(match[1]);
  }
  return null;
}

/** Ports exposed to the public internet by Funnel — always expected empty. */
export function parseFunnelPorts(stdout: string): number[] {
  const allow = parseJson(stdout)?.['AllowFunnel'];
  if (!isRecord(allow)) return [];
  const ports = new Set<number>();
  for (const [key, enabled] of Object.entries(allow)) {
    if (enabled === false) continue;
    const port = portOfKey(key);
    if (port !== null) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

/** Lowest port at or above `from` that nothing in `taken` uses. */
export function pickPort(from: number, taken: ReadonlySet<number>): number | null {
  for (let port = from; port < from + PORT_SCAN_LIMIT; port++) {
    if (!taken.has(port)) return port;
  }
  return null;
}

// ---- the endpoint -----------------------------------------------------------

export async function openTailscaleEndpoint(
  request: EndpointRequest,
  deps: TailscaleEndpointDeps,
): Promise<EndpointHandle> {
  const { targetId, exec, probe, reserved } = deps;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const dnsName = await readDnsName();
  const entries = await reclaimStaleEntries(dnsName, await readServeEntries());
  const listeners = entries.map((entry) => entry.httpsPort);
  // A backend port is a port something on the target is already expected to be
  // listening on. Stepping over those is what keeps a new run from colliding
  // with an instance that outlived the daemon which started it.
  const backends = entries.flatMap((entry) =>
    entry.backendPort === null ? [] : [entry.backendPort],
  );

  const servicePort =
    request.port ??
    pickPort(TAILSCALE_SERVICE_PORT_BASE, union(reserved, backends)) ??
    fail('no free service port');
  // A separate range for the tailnet listener: the HTTPS port belongs to
  // tailscaled and the service port to the service, and keeping them apart
  // means a service that binds more than loopback cannot collide with it.
  const httpsPort =
    pickPort(TAILSCALE_HTTPS_PORT_BASE, union(reserved, listeners)) ??
    fail('no free tailnet HTTPS port');

  reserved.add(servicePort);
  reserved.add(httpsPort);

  try {
    // No replace step is needed: an HTTPS port that still has a handler is in
    // `listeners` and was skipped above, and a handler whose service is gone
    // was already withdrawn by reclaimStaleEntries.
    await run(serveArgv(httpsPort, servicePort), 'publish the endpoint');
    await assertTailnetOnly(httpsPort);
  } catch (error: unknown) {
    reserved.delete(servicePort);
    reserved.delete(httpsPort);
    throw error;
  }

  const healthPath = request.healthPath ?? '/';
  const url = `https://${dnsName}:${httpsPort}`;
  const endpoint: ServiceEndpoint = {
    id: `tailscale-${targetId}-${httpsPort}`,
    targetId,
    // The port the *service* listens on over there; the URL carries the tailnet
    // listener's own port, exactly as a forwarded endpoint's would.
    port: servicePort,
    protocol: 'https',
    url: null,
    scope: 'published',
  };
  const closeListeners = new Set<(reason: string | null) => void>();
  let closed = false;

  async function check(): Promise<EndpointHealth> {
    const checkedAt = new Date().toISOString();
    if (closed) return { state: 'closed', checkedAt, reason: null };
    if (await probe(`${url}${healthPath === '/' ? '' : healthPath}`)) {
      endpoint.url = url;
      return { state: 'healthy', checkedAt, reason: null };
    }
    return { state: 'unhealthy', checkedAt, reason: `No response from ${url}${healthPath}` };
  }

  return {
    endpoint,
    health: check,

    async waitUntilHealthy(timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS) {
      const deadline = Date.now() + timeoutMs;
      let last = await check();
      while (last.state !== 'healthy' && last.state !== 'closed' && Date.now() < deadline) {
        await sleep(pollIntervalMs);
        last = await check();
      }
      return last;
    },

    onClose(listener) {
      closeListeners.add(listener);
      return () => void closeListeners.delete(listener);
    },

    async close() {
      if (closed) return;
      closed = true;
      endpoint.url = null;
      // Best effort: a close() that throws would break every stop path, but a
      // serve config left behind is worth saying out loud.
      let reason: string | null = null;
      try {
        const result = await exec(
          { argv: serveOffArgv(httpsPort, servicePort) },
          { timeoutMs: COMMAND_TIMEOUT_MS },
        );
        if (result.exitCode !== 0) {
          reason =
            `tailscale serve is still published on port ${httpsPort} of "${targetId}": ` +
            (result.stderr.trim() || `\`tailscale serve … off\` exited with ${result.exitCode}`);
        }
      } catch (error: unknown) {
        reason = `Could not reach "${targetId}" to unpublish port ${httpsPort}: ` + describe(error);
      }
      reserved.delete(servicePort);
      reserved.delete(httpsPort);
      for (const listener of closeListeners) listener(reason);
      closeListeners.clear();
    },
  };

  // ---- helpers that need the deps ------------------------------------------

  async function run(argv: string[], what: string): Promise<CommandResult> {
    let result: CommandResult;
    try {
      result = await exec({ argv }, { timeoutMs: COMMAND_TIMEOUT_MS });
    } catch (error: unknown) {
      // command-not-found is the one worth naming: it is a prerequisite, not
      // an outage, and the operator can fix it in one step.
      if (error instanceof TransportError && error.code === 'command-not-found') {
        throw endpointFailed(
          `Target "${targetId}" has no \`tailscale\` command — install Tailscale there to run ` +
            'managed T3 instances on it',
        );
      }
      throw error;
    }
    if (result.exitCode !== 0) {
      throw endpointFailed(
        `Could not ${what} on target "${targetId}": ` +
          (result.stderr.trim() ||
            `\`${argv.slice(0, 2).join(' ')}\` exited with ${result.exitCode}`),
      );
    }
    return result;
  }

  async function readDnsName(): Promise<string> {
    const result = await run(['tailscale', 'status', '--json'], 'read the tailnet status');
    const name = parseSelfDnsName(result.stdout);
    if (name === null) {
      throw endpointFailed(
        `Target "${targetId}" reported no MagicDNS name — enable MagicDNS and HTTPS ` +
          'certificates for the tailnet before serving T3 from it',
      );
    }
    return name;
  }

  /** A missing or empty serve config is a normal state, not a failure. */
  async function readServeEntries(): Promise<ServeEntry[]> {
    try {
      const result = await exec(
        { argv: ['tailscale', 'serve', 'status', '--json'] },
        { timeoutMs: COMMAND_TIMEOUT_MS },
      );
      return result.exitCode === 0 ? parseServeEntries(result.stdout) : [];
    } catch {
      return [];
    }
  }

  function offQuietly(httpsPort: number, servicePort: number): Promise<unknown> {
    return exec(
      { argv: serveOffArgv(httpsPort, servicePort) },
      { timeoutMs: COMMAND_TIMEOUT_MS },
    ).catch(() => undefined);
  }

  /**
   * Withdraw serve entries this feature left behind.
   *
   * Only entries in both of apm's own port ranges are considered, and only
   * when the published URL no longer answers — a live instance keeps its
   * listener, and anything a human published is never touched. Without this
   * step a crashed daemon's listeners would pile up one port at a time.
   */
  async function reclaimStaleEntries(
    dnsName: string,
    entries: ServeEntry[],
  ): Promise<ServeEntry[]> {
    const kept: ServeEntry[] = [];
    for (const entry of entries) {
      if (!isOurs(entry) || reserved.has(entry.httpsPort)) {
        kept.push(entry);
        continue;
      }
      if (await probe(`https://${dnsName}:${entry.httpsPort}`, RECLAIM_PROBE_TIMEOUT_MS)) {
        kept.push(entry); // something is still serving there
        continue;
      }
      await offQuietly(entry.httpsPort, entry.backendPort ?? entry.httpsPort);
    }
    return kept;
  }

  function isOurs(entry: ServeEntry): boolean {
    return (
      inRange(entry.httpsPort, TAILSCALE_HTTPS_PORT_BASE) &&
      entry.backendPort !== null &&
      inRange(entry.backendPort, TAILSCALE_SERVICE_PORT_BASE)
    );
  }

  /**
   * The whole promise of this endpoint is "your tailnet, nobody else". If the
   * machine has Funnel on for our port, the endpoint is public — so it is
   * withdrawn again rather than reported as ready.
   */
  async function assertTailnetOnly(port: number): Promise<void> {
    let funnelled: number[];
    try {
      const result = await exec(
        { argv: ['tailscale', 'serve', 'status', '--json'] },
        { timeoutMs: COMMAND_TIMEOUT_MS },
      );
      funnelled = result.exitCode === 0 ? parseFunnelPorts(result.stdout) : [];
    } catch {
      return; // an unreadable config is reported by the health check instead
    }
    if (!funnelled.includes(port)) return;
    await exec({ argv: serveOffArgv(port, port) }, { timeoutMs: COMMAND_TIMEOUT_MS }).catch(
      () => undefined,
    );
    throw endpointFailed(
      `Target "${targetId}" exposes port ${port} through Tailscale Funnel, which is the public ` +
        'internet — a managed T3 instance is only ever published inside the tailnet',
    );
  }

  function endpointFailed(message: string): TransportError {
    return new TransportError('endpoint-failed', targetId, message);
  }

  function fail(what: string): never {
    throw endpointFailed(`Target "${targetId}" has ${what} left`);
  }
}

// ---- small shared bits ------------------------------------------------------

function parseJson(stdout: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(stdout);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `host:port`, `host:port/path` or a bare `port` (the TCP section) -> port. */
function portOfKey(key: string): number | null {
  const match = /^(?:.*:)?(\d+)(?:\/.*)?$/.exec(key.trim());
  if (!match?.[1]) return null;
  const port = Number(match[1]);
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : null;
}

function union(a: ReadonlySet<number>, b: readonly number[]): Set<number> {
  return new Set([...a, ...b]);
}

/** Inside one of apm's own allocation ranges. */
function inRange(port: number, from: number): boolean {
  return port >= from && port < from + PORT_SCAN_LIMIT;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
