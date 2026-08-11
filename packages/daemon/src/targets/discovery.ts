/**
 * Tailnet discovery — the only source of candidate machines.
 *
 * `tailscale status --json` on **this** machine (the hub) already knows every
 * peer the tailnet lets it see, so discovery is one structured argv call and a
 * parse. There is no host scanning, no port probing and no free-form hostname
 * anywhere: a machine that is not on the tailnet cannot appear here, and a
 * machine that appears here is still only a name on a list.
 *
 * Discovery is display-only. Nothing in this module registers a target,
 * approves anything or opens a connection — approving one candidate is a
 * separate, explicit act (see routes.ts), which is what keeps the #17 security
 * model intact: a human names the machine that may run work.
 *
 * The parsing style is deliberately the same as tailscale.ts's: total functions
 * over the JSON, a missing or unreadable field is simply absent rather than an
 * error, and every call carries the same 15s timeout so a wedged tailscaled
 * cannot hang a request.
 */
import {
  TransportError,
  type CommandResult,
  type CommandSpec,
  type ExecOptions,
  type ExecutionTarget,
  type TargetCandidate,
} from '@apm/shared';
import { ApiFailure } from '../context.js';

/** Same budget tailscale.ts uses: a `tailscale` call must never hang a request. */
export const DISCOVERY_TIMEOUT_MS = 15_000;

/** `tailscale status --json`, run on the hub. */
export const STATUS_ARGV = ['tailscale', 'status', '--json'] as const;

/** Runs argv on the machine the daemon itself runs on. */
export type HubExec = (spec: CommandSpec, options?: ExecOptions) => Promise<CommandResult>;

/** One tailnet peer, as far as this module cares. */
export interface TailnetPeer {
  hostname: string;
  /** MagicDNS name without its trailing dot; empty when the peer reports none. */
  dnsName: string;
  online: boolean;
  os: string | null;
}

// ---- pure helpers (unit-tested directly) ------------------------------------

/**
 * Peers from `tailscale status --json`, hub excluded.
 *
 * `Self` is a sibling of `Peer` in that document, so the hub is out by
 * construction; it is filtered by name as well, because a hub that shows up as
 * its own candidate would be an invitation to point apm at itself over SSH.
 */
export function parseTailnetPeers(stdout: string): TailnetPeer[] {
  const status = parseJson(stdout);
  const peers = status?.['Peer'];
  if (!isRecord(peers)) return [];

  const self = isRecord(status?.['Self']) ? status['Self'] : null;
  const selfNames = new Set(
    [dnsName(self?.['DNSName']), text(self?.['HostName'])]
      .filter((name) => name !== '')
      .map((name) => name.toLowerCase()),
  );

  const found: TailnetPeer[] = [];
  for (const entry of Object.values(peers)) {
    if (!isRecord(entry)) continue;
    const name = dnsName(entry['DNSName']);
    const hostname = text(entry['HostName']) || firstLabel(name);
    if (hostname === '' && name === '') continue;
    if (selfNames.has(hostname.toLowerCase()) || selfNames.has(name.toLowerCase())) continue;
    found.push({
      hostname,
      dnsName: name,
      online: entry['Online'] === true,
      os: text(entry['OS']) || null,
    });
  }
  return found.sort((a, b) => a.hostname.localeCompare(b.hostname));
}

/**
 * Peers plus the registry's answer to "is this machine already a target?".
 *
 * Matching is on the address a target would use — its tailnet name — with the
 * optional `user@` prefix of an SSH address ignored, plus the id as a fallback
 * so a hand-written `targets.json` entry that named the machine by id is
 * recognised too.
 */
export function mergeCandidates(
  peers: TailnetPeer[],
  targets: readonly ExecutionTarget[],
): TargetCandidate[] {
  const byName = new Map<string, string>();
  for (const target of targets) {
    if (target.kind === 'local') continue;
    for (const key of [
      hostOfAddress(target.identity.address),
      dnsName(target.identity.hostname),
      target.id,
    ]) {
      const normalized = key.toLowerCase();
      if (normalized !== '' && !byName.has(normalized)) byName.set(normalized, target.id);
    }
  }

  const taken = new Set(targets.map((target) => target.id.toLowerCase()));
  return peers.map((peer) => {
    const address = peer.dnsName || peer.hostname;
    const registeredTargetId =
      byName.get(peer.dnsName.toLowerCase()) ?? byName.get(peer.hostname.toLowerCase()) ?? null;
    return {
      hostname: peer.hostname,
      dnsName: peer.dnsName,
      address,
      online: peer.online,
      os: peer.os,
      registeredTargetId,
      suggestedId: suggestTargetId(peer.hostname || firstLabel(peer.dnsName), taken),
    };
  });
}

/**
 * The peer an address names, or null.
 *
 * This is what keeps the tailnet the only way in: an approval carries an
 * address, and the address has to belong to a machine the tailnet just
 * reported. `targets.json` stays the escape hatch for anything else — editing
 * it by hand is a deliberate act on this machine, which a request is not.
 */
export function findPeer(peers: readonly TailnetPeer[], address: string): TailnetPeer | null {
  const host = hostOfAddress(address).toLowerCase();
  if (host === '') return null;
  return (
    peers.find(
      (peer) => peer.dnsName.toLowerCase() === host || peer.hostname.toLowerCase() === host,
    ) ?? null
  );
}

/**
 * A target id to offer for a candidate: the hostname reduced to what
 * `targetIdSchema` accepts, then made unique against the ids already in use.
 * Empty when nothing usable is left — the user names the machine instead of
 * apm inventing an id nobody recognises.
 */
export function suggestTargetId(hostname: string, taken: ReadonlySet<string> = new Set()): string {
  const base = hostname
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+$/, '')
    .slice(0, 60);
  if (base === '') return '';
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix < 100; suffix++) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return '';
}

// ---- the discovery call -----------------------------------------------------

/**
 * Ask this machine's tailscale for its peers.
 *
 * Every failure mode is named rather than swallowed: no `tailscale` binary, a
 * tailscaled that is not running or not logged in, and a call that ran out of
 * time. None of them can hang, and none of them is reported as an empty tailnet
 * — "no machines" and "cannot ask" must not look alike in the UI.
 */
export async function readTailnetPeers(exec: HubExec): Promise<TailnetPeer[]> {
  let result: CommandResult;
  try {
    result = await exec({ argv: [...STATUS_ARGV] }, { timeoutMs: DISCOVERY_TIMEOUT_MS });
  } catch (error: unknown) {
    throw unavailable(describeExecFailure(error));
  }
  if (result.exitCode !== 0) {
    throw unavailable(
      result.stderr.trim() ||
        `\`tailscale status\` exited with ${result.exitCode ?? `signal ${result.signal}`}`,
    );
  }
  return parseTailnetPeers(result.stdout);
}

function describeExecFailure(error: unknown): string {
  if (error instanceof TransportError) {
    if (error.code === 'command-not-found') {
      return 'this machine has no `tailscale` command — install Tailscale here to discover machines on your tailnet';
    }
    if (error.code === 'timeout') {
      return `\`tailscale status\` did not answer within ${DISCOVERY_TIMEOUT_MS / 1000}s — is tailscaled running?`;
    }
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function unavailable(reason: string): ApiFailure {
  return new ApiFailure(
    503,
    'tailscale-unavailable',
    `Could not read the tailnet from this machine: ${reason}`,
  );
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

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** MagicDNS names come back fully qualified, with the root dot attached. */
function dnsName(value: unknown): string {
  return text(value).replace(/\.$/, '');
}

function firstLabel(name: string): string {
  return name.split('.')[0] ?? '';
}

/** `user@host` -> `host`; anything else is already the host. */
function hostOfAddress(address: string | null): string {
  const value = dnsName(address);
  const at = value.lastIndexOf('@');
  return at === -1 ? value : value.slice(at + 1);
}
