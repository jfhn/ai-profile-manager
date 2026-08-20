/**
 * Tailnet discovery, driven through a scripted exec channel.
 *
 * Everything this module decides — which machines exist, which of them is the
 * hub, which are already targets and what happens when tailscale cannot answer
 * — is exercised here without a tailnet.
 */
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TransportError,
  type CommandResult,
  type CommandSpec,
  type ExecOptions,
} from '@apm/shared';
import { ApiFailure } from '../context.js';
import { createTargetRegistry } from './registry.js';
import { createLocalTransport } from './local.js';
import { createSshTransport } from './ssh.js';
import {
  DISCOVERY_TIMEOUT_MS,
  STATUS_ARGV,
  findPeer,
  mergeCandidates,
  parseTailnetPeers,
  readTailnetPeers,
  suggestTargetId,
  type TailnetPeer,
} from './discovery.js';

const STATUS_JSON = JSON.stringify({
  Self: { ID: 'n1', HostName: 'hub', DNSName: 'hub.tailnet.ts.net.', OS: 'linux', Online: true },
  MagicDNSSuffix: 'tailnet.ts.net',
  Peer: {
    'nodekey:bbb': {
      ID: 'n3',
      HostName: 'laptop',
      DNSName: 'laptop.tailnet.ts.net.',
      OS: 'macOS',
      Online: false,
      TailscaleIPs: ['100.64.0.3'],
    },
    'nodekey:aaa': {
      ID: 'n2',
      HostName: 'dev-box',
      DNSName: 'dev-box.tailnet.ts.net.',
      OS: 'linux',
      Online: true,
      TailscaleIPs: ['100.64.0.2'],
    },
    // A peer that reports neither Online nor OS: both are unknown, not false
    // information.
    'nodekey:ccc': { ID: 'n4', HostName: 'phone', DNSName: 'phone.tailnet.ts.net.' },
  },
});

interface Harness {
  exec(spec: CommandSpec, options?: ExecOptions): Promise<CommandResult>;
  readonly calls: Array<{ argv: string[]; options: ExecOptions | undefined }>;
}

function harness(
  result: Partial<CommandResult> | TransportError = { stdout: STATUS_JSON },
): Harness {
  const calls: Array<{ argv: string[]; options: ExecOptions | undefined }> = [];
  return {
    calls,
    async exec(spec, options) {
      calls.push({ argv: [...spec.argv], options });
      if (result instanceof TransportError) throw result;
      return {
        exitCode: result.exitCode ?? 0,
        signal: result.signal ?? null,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      };
    },
  };
}

function peer(overrides: Partial<TailnetPeer> = {}): TailnetPeer {
  return {
    hostname: 'dev-box',
    dnsName: 'dev-box.tailnet.ts.net',
    online: true,
    os: 'linux',
    ...overrides,
  };
}

function localRegistry() {
  return createTargetRegistry(
    createLocalTransport({
      profiles: { list: () => [], envFor: () => ({ session: {}, appOnly: null }) },
      shimsDir: path.join(os.tmpdir(), 'apm-discovery-shims'),
    }),
  );
}

/** A registered SSH target; constructing one opens no connection. */
function remote(id: string, address: string) {
  return createSshTransport({ id, label: id, address, approved: true });
}

describe('tailnet status parsing', () => {
  it('reads every peer without its trailing dot, and never the hub itself', () => {
    expect(parseTailnetPeers(STATUS_JSON)).toEqual([
      { hostname: 'dev-box', dnsName: 'dev-box.tailnet.ts.net', online: true, os: 'linux' },
      { hostname: 'laptop', dnsName: 'laptop.tailnet.ts.net', online: false, os: 'macOS' },
      { hostname: 'phone', dnsName: 'phone.tailnet.ts.net', online: false, os: null },
    ]);
  });

  it('drops the hub even if it is listed among the peers', () => {
    const withSelfAsPeer = JSON.stringify({
      Self: { HostName: 'hub', DNSName: 'hub.tailnet.ts.net.' },
      Peer: {
        'nodekey:self': { HostName: 'hub', DNSName: 'hub.tailnet.ts.net.', Online: true },
        'nodekey:aaa': { HostName: 'dev-box', DNSName: 'dev-box.tailnet.ts.net.', Online: true },
      },
    });
    expect(parseTailnetPeers(withSelfAsPeer).map((it) => it.hostname)).toEqual(['dev-box']);
  });

  it('treats an unreadable or empty document as no peers', () => {
    for (const stdout of ['', 'not json', '{}', '[]', JSON.stringify({ Peer: 'nonsense' })]) {
      expect(parseTailnetPeers(stdout)).toEqual([]);
    }
    // A peer entry that is not an object is skipped rather than fatal.
    expect(parseTailnetPeers(JSON.stringify({ Peer: { a: 42, b: { HostName: 'ok' } } }))).toEqual([
      { hostname: 'ok', dnsName: '', online: false, os: null },
    ]);
  });

  it('falls back to the first DNS label when a peer reports no hostname', () => {
    const stdout = JSON.stringify({ Peer: { a: { DNSName: 'build-box.tailnet.ts.net.' } } });
    expect(parseTailnetPeers(stdout)[0]).toMatchObject({
      hostname: 'build-box',
      dnsName: 'build-box.tailnet.ts.net',
    });
  });
});

describe('candidates against the registry', () => {
  it('marks the machines that already are targets, by address or by id', () => {
    const registry = localRegistry();
    // An SSH address may carry a user; the machine is the part after the @.
    registry.register(remote('workstation', 'jan@dev-box.tailnet.ts.net'));
    // A hand-written entry may reach the machine by some other name entirely;
    // its id still identifies it.
    registry.register(remote('laptop', 'laptop.internal.example'));

    const candidates = mergeCandidates(
      [
        peer(),
        peer({ hostname: 'laptop', dnsName: 'laptop.tailnet.ts.net', online: false }),
        peer({ hostname: 'phone', dnsName: 'phone.tailnet.ts.net' }),
      ],
      registry.list(),
    );

    expect(candidates.map((it) => [it.hostname, it.registeredTargetId])).toEqual([
      ['dev-box', 'workstation'],
      ['laptop', 'laptop'],
      ['phone', null],
    ]);
    expect(candidates[2]).toMatchObject({
      address: 'phone.tailnet.ts.net',
      online: true,
      os: 'linux',
      suggestedId: 'phone',
    });
  });

  it('addresses a machine by hostname when the tailnet has no MagicDNS name', () => {
    const [candidate] = mergeCandidates([peer({ dnsName: '' })], []);
    expect(candidate).toMatchObject({ address: 'dev-box', dnsName: '' });
  });

  it('recognises the machine an address names, and only that machine', () => {
    const peers = [peer(), peer({ hostname: 'laptop', dnsName: '' })];
    expect(findPeer(peers, 'dev-box.tailnet.ts.net')?.hostname).toBe('dev-box');
    // The user part of an SSH address is not the machine.
    expect(findPeer(peers, 'jan@Dev-Box.tailnet.ts.net')?.hostname).toBe('dev-box');
    // A machine without a MagicDNS name is still addressable by hostname.
    expect(findPeer(peers, 'laptop')?.hostname).toBe('laptop');
    expect(findPeer(peers, '10.0.0.5')).toBeNull();
    expect(findPeer(peers, 'dev-box.other.example')).toBeNull();
    expect(findPeer(peers, '')).toBeNull();
  });

  it('suggests a usable, free target id', () => {
    expect(suggestTargetId('Dev Box!')).toBe('dev-box');
    expect(suggestTargetId('--weird--')).toBe('weird');
    expect(suggestTargetId('')).toBe('');
    expect(suggestTargetId('dev-box', new Set(['dev-box']))).toBe('dev-box-2');
    // 'local' is always taken, so a machine called that gets its own id.
    const [candidate] = mergeCandidates([peer({ hostname: 'local' })], localRegistry().list());
    expect(candidate?.suggestedId).toBe('local-2');
  });
});

describe('reading the tailnet from this machine', () => {
  it('runs one structured argv with the shared timeout', async () => {
    const h = harness();
    const peers = await readTailnetPeers(h.exec);

    expect(h.calls).toEqual([
      { argv: [...STATUS_ARGV], options: { timeoutMs: DISCOVERY_TIMEOUT_MS } },
    ]);
    expect(peers.map((it) => it.hostname)).toEqual(['dev-box', 'laptop', 'phone']);
  });

  it('names Tailscale as the prerequisite when this machine does not have it', async () => {
    const h = harness(
      new TransportError('command-not-found', 'local', 'Command not found: tailscale'),
    );
    const error = await readTailnetPeers(h.exec).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ApiFailure);
    expect(error).toMatchObject({ statusCode: 503, code: 'tailscale-unavailable' });
    expect((error as ApiFailure).message).toContain('install Tailscale');
  });

  it('reports a stopped tailscaled in its own words instead of an empty tailnet', async () => {
    const h = harness({ exitCode: 1, stderr: 'Tailscale is stopped.\n' });
    const error = await readTailnetPeers(h.exec).catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ statusCode: 503, code: 'tailscale-unavailable' });
    expect((error as ApiFailure).message).toContain('Tailscale is stopped.');
  });

  it('says the call timed out rather than hanging on it', async () => {
    const h = harness(new TransportError('timeout', 'local', 'tailscale did not finish'));
    const error = await readTailnetPeers(h.exec).catch((thrown: unknown) => thrown);
    expect((error as ApiFailure).message).toContain('did not answer within 15s');
  });
});
