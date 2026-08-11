/**
 * The Tailscale endpoint, driven through a scripted exec channel.
 *
 * Everything this module decides — which ports to take, what argv to run, what
 * URL that produces and what `close()` undoes — is exercised here. The SSH
 * spawn underneath it stays untested like the rest of ssh.ts; the two-device
 * live check covers that.
 */
import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { TransportError, type CommandResult, type CommandSpec } from '@apm/shared';
import {
  BACKEND_PROBE_DEAD_EXIT_CODE,
  backendIsListening,
  backendProbeArgv,
  openTailscaleEndpoint,
  parseFunnelPorts,
  parseSelfDnsName,
  parseServedPorts,
  parseServeEntries,
  pickPort,
  serveArgv,
  serveOffArgv,
} from './tailscale.js';
import { createLocalTransport } from './local.js';

const TARGET_ID = 'dev-box';
const DNS_NAME = 'dev-box.tailnet.ts.net';

const STATUS_JSON = JSON.stringify({
  Self: { DNSName: `${DNS_NAME}.`, TailscaleIPs: ['100.64.0.1'] },
  MagicDNSSuffix: 'tailnet.ts.net',
});

/** One published listener and what it proxies to, as serve status reports it. */
interface Entry {
  https: number;
  backend: number;
}

function serveStatusJson(
  options: { web?: number[]; entries?: Entry[]; tcp?: number[]; funnel?: number[] } = {},
): string {
  const web: Record<string, unknown> = {};
  const entries = [
    ...(options.web ?? []).map((port) => ({ https: port, backend: port })),
    ...(options.entries ?? []),
  ];
  for (const entry of entries) {
    web[`${DNS_NAME}:${entry.https}`] = {
      Handlers: { '/': { Proxy: `http://127.0.0.1:${entry.backend}` } },
    };
  }
  const tcp: Record<string, unknown> = {};
  for (const port of options.tcp ?? []) tcp[String(port)] = { HTTPS: true };
  const allowFunnel: Record<string, boolean> = {};
  for (const port of options.funnel ?? []) allowFunnel[`${DNS_NAME}:${port}`] = true;
  return JSON.stringify({ TCP: tcp, Web: web, AllowFunnel: allowFunnel });
}

interface Harness {
  exec(spec: CommandSpec): Promise<CommandResult>;
  /** Every argv the endpoint ran, in order. */
  readonly calls: string[][];
  script(argv: string[], result: Partial<CommandResult>): void;
  reject(argv: string[], error: TransportError): void;
}

function harness(serveStatus = serveStatusJson()): Harness {
  const calls: string[][] = [];
  const results = new Map<string, Partial<CommandResult>>();
  const failures = new Map<string, TransportError>();
  const key = (argv: readonly string[]) => argv.join('\u0000');

  results.set(key(['tailscale', 'status', '--json']), { stdout: STATUS_JSON });
  results.set(key(['tailscale', 'serve', 'status', '--json']), { stdout: serveStatus });

  return {
    calls,
    script: (argv, result) => void results.set(key(argv), result),
    reject: (argv, error) => void failures.set(key(argv), error),
    async exec(spec) {
      calls.push([...spec.argv]);
      const failure = failures.get(key(spec.argv));
      if (failure) throw failure;
      const result = results.get(key(spec.argv)) ?? {};
      return {
        exitCode: result.exitCode ?? 0,
        signal: result.signal ?? null,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      };
    },
  };
}

function deps(h: Harness, probe: (url: string) => Promise<boolean>, reserved = new Set<number>()) {
  return { targetId: TARGET_ID, exec: h.exec, probe, reserved, pollIntervalMs: 1 };
}

describe('tailscale serve argv', () => {
  it('publishes a loopback port over HTTPS in the background, never funnelled', () => {
    expect(serveArgv(8443, 4800)).toEqual([
      'tailscale',
      'serve',
      '--bg',
      '--https=8443',
      'http://127.0.0.1:4800',
    ]);
    // Nothing user-supplied and nothing shell-shaped: every entry is its own
    // argv element and only the two port numbers vary.
    expect(serveArgv(8443, 4800).join(' ')).not.toContain('funnel');
  });

  it('undoes exactly the invocation it made', () => {
    expect(serveOffArgv(8443, 4800)).toEqual([
      'tailscale',
      'serve',
      '--https=8443',
      'http://127.0.0.1:4800',
      'off',
    ]);
  });
});

describe('target-local backend probe', () => {
  it('distinguishes a bound loopback backend from a free port', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('No TCP listen address');

    const transport = createLocalTransport({
      profiles: { list: () => [], envFor: () => ({}) },
    });
    const exec = (spec: CommandSpec, options?: { timeoutMs?: number }) =>
      transport.exec(spec, options);

    try {
      expect(await backendIsListening(exec, address.port)).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    expect(await backendIsListening(exec, address.port)).toBe(false);
  });
});

describe('tailscale status parsing', () => {
  it('reads the target’s MagicDNS name without its trailing dot', () => {
    expect(parseSelfDnsName(STATUS_JSON)).toBe(DNS_NAME);
    expect(parseSelfDnsName('{}')).toBeNull();
    expect(parseSelfDnsName('not json')).toBeNull();
    expect(parseSelfDnsName(JSON.stringify({ Self: { DNSName: '' } }))).toBeNull();
  });

  it('reads served ports out of the host:port keys', () => {
    expect(parseServedPorts(serveStatusJson({ web: [443, 8443] }))).toEqual([443, 8443]);
    // An empty or unreadable config just means nothing is served yet.
    expect(parseServedPorts('')).toEqual([]);
    expect(parseServedPorts('{}')).toEqual([]);
  });

  it('reads funnelled ports and ignores the ones switched off', () => {
    expect(parseFunnelPorts(serveStatusJson({ funnel: [8443] }))).toEqual([8443]);
    expect(
      parseFunnelPorts(JSON.stringify({ AllowFunnel: { [`${DNS_NAME}:8443`]: false } })),
    ).toEqual([]);
  });

  it('skips ports that are taken', () => {
    expect(pickPort(8443, new Set())).toBe(8443);
    expect(pickPort(8443, new Set([8443, 8444]))).toBe(8445);
  });

  it('reads each listener together with the loopback port behind it', () => {
    const status = serveStatusJson({
      entries: [{ https: 8443, backend: 4800 }],
      tcp: [9000],
    });
    expect(parseServeEntries(status)).toEqual([
      { httpsPort: 8443, backendPort: 4800 },
      // A TCP forward owns its port but names no backend we can read.
      { httpsPort: 9000, backendPort: null },
    ]);
    expect(parseServeEntries('')).toEqual([]);
  });
});

describe('openTailscaleEndpoint', () => {
  it('publishes an HTTPS URL on the target’s own tailnet address', async () => {
    const h = harness();
    let serving = false;
    const handle = await openTailscaleEndpoint(
      { port: null, healthPath: '/' },
      deps(h, async () => serving),
    );

    expect(h.calls).toContainEqual(serveArgv(8443, 4800));
    expect(handle.endpoint.scope).toBe('published');
    expect(handle.endpoint.protocol).toBe('https');
    // The port is where the *service* listens on the target; the URL carries
    // the tailnet listener's own port.
    expect(handle.endpoint.port).toBe(4800);
    expect(handle.endpoint.url).toBeNull();

    const before = await handle.health();
    expect(before.state).toBe('unhealthy');

    serving = true;
    expect((await handle.waitUntilHealthy(1_000)).state).toBe('healthy');
    expect(handle.endpoint.url).toBe(`https://${DNS_NAME}:8443`);
  });

  it('probes the published URL rather than anything local', async () => {
    const h = harness();
    const probed: string[] = [];
    const handle = await openTailscaleEndpoint(
      { port: null, healthPath: '/health' },
      deps(h, async (url) => {
        probed.push(url);
        return false;
      }),
    );
    await handle.health();
    expect(probed).toEqual([`https://${DNS_NAME}:8443/health`]);
  });

  it('steps over ports the target already serves', async () => {
    const h = harness(serveStatusJson({ web: [443, 8443, 8444] }));
    const handle = await openTailscaleEndpoint(
      { port: null },
      deps(h, async () => true),
    );
    expect(handle.endpoint.url).toBeNull(); // not probed yet
    expect(h.calls).toContainEqual(serveArgv(8445, 4800));
  });

  it('keeps two endpoints on one target apart', async () => {
    const reserved = new Set<number>();
    const first = await openTailscaleEndpoint(
      { port: null },
      deps(harness(), async () => true, reserved),
    );
    const second = await openTailscaleEndpoint(
      { port: null },
      deps(harness(), async () => true, reserved),
    );
    expect(first.endpoint.port).toBe(4800);
    expect(second.endpoint.port).toBe(4801);
    expect(await first.health()).toMatchObject({ state: 'healthy' });
    expect(first.endpoint.url).not.toBe(second.endpoint.url);
  });

  it('steps over a service port an earlier run is still holding', async () => {
    // Exactly the state a daemon restart met live: the previous instance
    // outlived it, still bound to 4800, still published on 8443.
    const h = harness(serveStatusJson({ entries: [{ https: 8443, backend: 4800 }] }));
    h.script(backendProbeArgv(4800), { exitCode: 0 });
    const handle = await openTailscaleEndpoint(
      { port: null },
      deps(h, async () => true),
    );

    expect(handle.endpoint.port).toBe(4801);
    expect(h.calls).toContainEqual(serveArgv(8444, 4801));
    // The live listener is left exactly as it was.
    expect(h.calls.some((argv) => argv.includes('off'))).toBe(false);
  });

  it('reclaims its own listener once nothing answers behind it', async () => {
    const h = harness(serveStatusJson({ entries: [{ https: 8443, backend: 4800 }] }));
    h.script(backendProbeArgv(4800), { exitCode: BACKEND_PROBE_DEAD_EXIT_CODE });
    const handle = await openTailscaleEndpoint(
      { port: null },
      deps(h, async () => {
        throw new Error('published URL probe must not decide stale-entry reclaim');
      }),
    );

    // The dead entry is withdrawn and both of its ports come back into use,
    // so a crashed daemon cannot leave listeners piling up one port at a time.
    expect(h.calls).toContainEqual(backendProbeArgv(4800));
    expect(h.calls).toContainEqual(serveOffArgv(8443, 4800));
    expect(handle.endpoint.port).toBe(4800);
    expect(h.calls).toContainEqual(serveArgv(8443, 4800));
  });

  it('keeps a listener when the target-local backend probe is inconclusive', async () => {
    const h = harness(serveStatusJson({ entries: [{ https: 8443, backend: 4800 }] }));
    h.script(backendProbeArgv(4800), { exitCode: 1, stderr: 'node could not run the probe' });

    const handle = await openTailscaleEndpoint(
      { port: null },
      deps(h, async () => true),
    );

    expect(h.calls.some((argv) => argv.includes('off'))).toBe(false);
    expect(handle.endpoint.port).toBe(4801);
    expect(h.calls).toContainEqual(serveArgv(8444, 4801));
  });

  it('never withdraws an entry outside its own port ranges', async () => {
    const h = harness(
      serveStatusJson({
        // Somebody's own site on 443, and a TCP forward apm knows nothing about.
        entries: [{ https: 443, backend: 3000 }],
        tcp: [9000],
      }),
    );
    await openTailscaleEndpoint(
      { port: null },
      deps(h, async () => false),
    );

    expect(h.calls.some((argv) => argv.includes('off'))).toBe(false);
    expect(h.calls).toContainEqual(serveArgv(8443, 4800));
  });

  it('honours a port the caller asked for', async () => {
    const h = harness();
    const handle = await openTailscaleEndpoint(
      { port: 4900 },
      deps(h, async () => true),
    );
    expect(handle.endpoint.port).toBe(4900);
    expect(h.calls).toContainEqual(serveArgv(8443, 4900));
  });

  it('unpublishes on close and frees the ports again', async () => {
    const reserved = new Set<number>();
    const h = harness();
    const handle = await openTailscaleEndpoint(
      { port: null },
      deps(h, async () => true, reserved),
    );
    await handle.waitUntilHealthy(1_000);

    const reasons: Array<string | null> = [];
    handle.onClose((reason) => void reasons.push(reason));
    await handle.close();

    expect(h.calls).toContainEqual(serveOffArgv(8443, 4800));
    expect(reasons).toEqual([null]);
    expect(handle.endpoint.url).toBeNull();
    expect((await handle.health()).state).toBe('closed');
    expect([...reserved]).toEqual([]);
    // Closing twice must not run the revocation a second time.
    const calls = h.calls.length;
    await handle.close();
    expect(h.calls).toHaveLength(calls);
  });

  it('says so when the serve config could not be withdrawn', async () => {
    const h = harness();
    const handle = await openTailscaleEndpoint(
      { port: null },
      deps(h, async () => true),
    );
    h.script(serveOffArgv(8443, 4800), { exitCode: 1, stderr: 'access denied' });

    const reasons: Array<string | null> = [];
    handle.onClose((reason) => void reasons.push(reason));
    await handle.close();
    expect(reasons[0]).toContain('still published');
    expect(reasons[0]).toContain('access denied');
  });

  it('names Tailscale as the prerequisite when the target does not have it', async () => {
    const h = harness();
    h.reject(
      ['tailscale', 'status', '--json'],
      new TransportError('command-not-found', TARGET_ID, 'Command not found: tailscale'),
    );

    const error = await openTailscaleEndpoint(
      { port: null },
      deps(h, async () => true),
    ).catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ code: 'endpoint-failed', targetId: TARGET_ID });
    expect((error as TransportError).message).toContain('install Tailscale');
  });

  it('reports the target’s own words when serve refuses', async () => {
    const h = harness();
    h.script(serveArgv(8443, 4800), { exitCode: 1, stderr: 'must be run as root' });

    const error = await openTailscaleEndpoint(
      { port: null },
      deps(h, async () => true),
    ).catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ code: 'endpoint-failed' });
    expect((error as TransportError).message).toContain('must be run as root');
  });

  it('asks for MagicDNS when the target reports no name', async () => {
    const h = harness();
    h.script(['tailscale', 'status', '--json'], { stdout: '{}' });

    const error = await openTailscaleEndpoint(
      { port: null },
      deps(h, async () => true),
    ).catch((thrown: unknown) => thrown);
    expect((error as TransportError).message).toContain('MagicDNS');
  });

  it('withdraws and refuses an endpoint the target funnelled to the internet', async () => {
    // The serve config comes back with Funnel on for the port we just took.
    const h = harness(serveStatusJson({ funnel: [8443] }));

    const error = await openTailscaleEndpoint(
      { port: null },
      deps(h, async () => true),
    ).catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ code: 'endpoint-failed' });
    expect((error as TransportError).message).toContain('Funnel');
    expect(h.calls).toContainEqual(serveOffArgv(8443, 8443));
  });
});
