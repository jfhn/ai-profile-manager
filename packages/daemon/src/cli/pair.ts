/**
 * Target-local pairing for a running APM-managed T3 instance.
 *
 * Remote instances are deliberately absent from the target's daemon store:
 * the hub owns their lifecycle. The target does have two authoritative local
 * facts, though: the live process argv contains its managed base dir + port,
 * and Tailscale's serve config maps that backend port to its published URL.
 * Pairing uses only those facts, then writes T3's short-lived secret straight
 * back to this process' stdout/stderr. It never enters daemon/API state or an
 * APM log.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseFunnelPorts, parseSelfDnsName, parseServeEntries } from '../targets/tailscale.js';
import { APM_MANAGED_T3_INSTANCE_ENV } from '../t3/identity.js';
import { CliError, type PairInvocation } from './parse.js';

export const PAIR_TTL = '15m';

export interface ManagedT3Process {
  pid: number;
  instanceId: string;
  baseDir: string;
  port: number;
}

export interface ProcessAttribution {
  realUid: number;
  effectiveUid: number;
  instanceMarker: string;
}

export type ProcessOwner = Pick<ProcessAttribution, 'realUid' | 'effectiveUid'>;

export type ProcFileReader = (file: string) => Buffer;

export interface PairProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface PairDeps {
  t3Dir: string;
  listProcesses?(): ManagedT3Process[];
  run?(argv: string[]): Promise<PairProcessResult>;
  writeStdout?(text: string): void;
  writeStderr?(text: string): void;
}

/** Run the complete workflow. Injectable I/O keeps tokens inside the test terminal sink. */
export async function runPair(invocation: PairInvocation, deps: PairDeps): Promise<void> {
  const listProcesses = deps.listProcesses ?? (() => discoverManagedT3Processes(deps.t3Dir));
  const run = deps.run ?? runProcess;
  const writeStdout = deps.writeStdout ?? ((text: string) => process.stdout.write(text));
  const writeStderr = deps.writeStderr ?? ((text: string) => process.stderr.write(text));

  const selected = selectManagedT3Process(listProcesses(), invocation.instanceId);
  const status = await requireSuccess(
    run(['tailscale', 'status', '--json']),
    "read this target's Tailscale status",
  );
  const serve = await requireSuccess(
    run(['tailscale', 'serve', 'status', '--json']),
    "read this target's published services",
  );
  const endpoint = resolvePublishedEndpoint(selected, status.stdout, serve.stdout);

  const pairArgv = t3PairArgv(selected.baseDir);
  let paired: PairProcessResult;
  try {
    paired = await run(pairArgv);
  } catch (error: unknown) {
    throw new CliError(
      `could not start \`t3 pair\`: ${describe(error)} — install T3 Code and ensure \`t3\` is on PATH`,
    );
  }

  // T3 owns this output, including its token. The only copies APM makes are
  // these in-memory strings and the bytes written to the invoking terminal.
  const stdout = replaceLocalPairingUrls(paired.stdout, endpoint);
  const stderr = replaceLocalPairingUrls(paired.stderr, endpoint);
  if (paired.exitCode !== 0 || paired.signal !== null) {
    if (stdout) writeStdout(stdout);
    if (stderr) writeStderr(stderr);
    throw new CliError(
      paired.signal
        ? `t3 pair was killed by ${paired.signal}`
        : `t3 pair exited with code ${paired.exitCode ?? 'unknown'}`,
    );
  }

  writeStdout(
    `Managed T3 instance: ${selected.instanceId}\n` +
      `Published endpoint: ${endpoint}\n` +
      `Use the T3 pairing output below with that endpoint.\n`,
  );
  if (stdout) writeStdout(stdout);
  if (stderr) writeStderr(stderr);
}

/** Exact argv used for the short-lived token; no shell string is constructed. */
export function t3PairArgv(baseDir: string): string[] {
  return ['t3', 'pair', '--base-dir', baseDir, '--ttl', PAIR_TTL];
}

/**
 * Select by exact id. Omitting it is convenient only when there is one safe
 * answer; ids and ports are listed for every ambiguous candidate.
 */
export function selectManagedT3Process(
  processes: ManagedT3Process[],
  instanceId?: string,
): ManagedT3Process {
  const candidates = [...processes].sort((a, b) => a.instanceId.localeCompare(b.instanceId));
  if (candidates.length === 0) {
    throw new CliError(
      'no running APM-managed T3 instance found on this machine — start one from the hub ' +
        'dashboard, then run `apm pair` here',
    );
  }

  if (instanceId !== undefined) {
    const matches = candidates.filter((candidate) => candidate.instanceId === instanceId);
    if (matches.length === 1) return matches[0] as ManagedT3Process;
    if (matches.length > 1) throw ambiguous(candidates);
    throw new CliError(
      `no running managed instance with id "${instanceId}"\nrunning instances:\n${formatCandidates(candidates)}`,
    );
  }
  if (candidates.length === 1) return candidates[0] as ManagedT3Process;
  throw ambiguous(candidates);
}

/** Read Linux process argv without shell parsing or trusting display-formatted `ps` output. */
export function discoverManagedT3Processes(
  t3Dir: string,
  procDir = '/proc',
  invokingUser = currentProcessOwner(),
  readFile: ProcFileReader = (file) => fs.readFileSync(file),
): ManagedT3Process[] {
  if (invokingUser === null) {
    throw new CliError(
      'cannot verify process ownership on this platform; `apm pair` requires Linux',
    );
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(procDir, { withFileTypes: true });
  } catch (error: unknown) {
    throw new CliError(`cannot inspect running processes in ${procDir}: ${describe(error)}`);
  }

  const found: ManagedT3Process[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const processDir = path.join(procDir, entry.name);
    try {
      // Ownership is the cheapest non-secret boundary. Never inspect argv or
      // environment from a process belonging to another user.
      const owner = readProcessOwner(processDir, readFile);
      if (
        owner === null ||
        owner.realUid !== invokingUser.realUid ||
        owner.effectiveUid !== invokingUser.effectiveUid
      ) {
        continue;
      }

      // Command lines can themselves carry secrets. Read one only after UID
      // acceptance, and reject unrelated shapes before touching environ.
      const argv = readFile(path.join(processDir, 'cmdline'))
        .toString('utf8')
        .split('\0')
        .filter((arg) => arg.length > 0);
      const candidate = managedT3CandidateFromArgv(Number(entry.name), argv, t3Dir);
      if (!candidate) continue;

      // Environments routinely hold credentials. This is intentionally the
      // last read, limited to a same-user, exact managed-shaped candidate.
      const marker = readProcessMarker(processDir, readFile);
      if (marker === candidate.instanceId) found.push(candidate);
    } catch {
      // Processes routinely exit or become unreadable while /proc is scanned.
    }
  }
  return found;
}

/** Recognize only `t3 serve` argv bound to an immediate child of APM's managed T3 dir. */
export function managedT3ProcessFromArgv(
  pid: number,
  argv: readonly string[],
  t3Dir: string,
  attribution: ProcessAttribution | null,
  invokingUser: ProcessOwner,
): ManagedT3Process | null {
  if (
    attribution === null ||
    attribution.realUid !== invokingUser.realUid ||
    attribution.effectiveUid !== invokingUser.effectiveUid
  ) {
    return null;
  }
  const candidate = managedT3CandidateFromArgv(pid, argv, t3Dir);
  if (!candidate || attribution.instanceMarker !== candidate.instanceId) return null;
  return candidate;
}

/** Parse only the exact non-secret argv shape APM launches for a managed instance. */
function managedT3CandidateFromArgv(
  pid: number,
  argv: readonly string[],
  t3Dir: string,
): ManagedT3Process | null {
  const serve = argv.indexOf('serve');
  if (serve < 0) return null;
  const baseDirs = optionValues(argv.slice(serve + 1), '--base-dir');
  const ports = optionValues(argv.slice(serve + 1), '--port');
  if (baseDirs.length !== 1 || ports.length !== 1) return null;

  const managedRoot = path.resolve(t3Dir);
  const baseDir = path.resolve(baseDirs[0] as string);
  const instanceId = path.basename(baseDir);
  if (instanceId === '' || path.dirname(baseDir) !== managedRoot) return null;

  const port = Number(ports[0]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return { pid, instanceId, baseDir, port };
}

function currentProcessOwner(): ProcessOwner | null {
  const realUid = process.getuid?.();
  const effectiveUid = process.geteuid?.();
  return realUid === undefined || effectiveUid === undefined ? null : { realUid, effectiveUid };
}

/** Read only the real/effective UID fields from non-secret proc status. */
function readProcessOwner(processDir: string, readFile: ProcFileReader): ProcessOwner | null {
  const status = readFile(path.join(processDir, 'status')).toString('utf8');
  const uid = /^Uid:\s+(\d+)\s+(\d+)(?:\s|$)/m.exec(status);
  if (!uid?.[1] || !uid[2]) return null;
  const realUid = Number(uid[1]);
  const effectiveUid = Number(uid[2]);
  if (!Number.isSafeInteger(realUid) || !Number.isSafeInteger(effectiveUid)) return null;
  return { realUid, effectiveUid };
}

/** Extract the one allowed marker only after owner + argv candidate validation. */
function readProcessMarker(processDir: string, readFile: ProcFileReader): string | null {
  const entries = readFile(path.join(processDir, 'environ')).toString('utf8').split('\0');
  const prefix = `${APM_MANAGED_T3_INSTANCE_ENV}=`;
  const markers = entries.filter((entry) => entry.startsWith(prefix));
  if (markers.length !== 1) return null;
  const instanceMarker = (markers[0] as string).slice(prefix.length);
  return instanceMarker === '' ? null : instanceMarker;
}

/** Match the selected backend to the same published URL the hub exposed. */
export function resolvePublishedEndpoint(
  instance: Pick<ManagedT3Process, 'instanceId' | 'port'>,
  tailscaleStatus: string,
  serveStatus: string,
): string {
  const dnsName = parseSelfDnsName(tailscaleStatus);
  if (dnsName === null) {
    throw new CliError(
      'this target has no Tailscale MagicDNS name — check `tailscale status` and enable MagicDNS',
    );
  }
  const matches = parseServeEntries(serveStatus).filter(
    (entry) => entry.backendPort === instance.port,
  );
  if (matches.length === 0) {
    throw new CliError(
      `managed instance ${instance.instanceId} is running on port ${instance.port}, but no ` +
        'published Tailscale Serve endpoint points to it — start it again from the hub dashboard',
    );
  }
  if (matches.length > 1) {
    throw new CliError(
      `more than one published endpoint points to managed instance ${instance.instanceId}; ` +
        'remove the stale Tailscale Serve entry before pairing',
    );
  }
  const match = matches[0] as (typeof matches)[number];
  if (parseFunnelPorts(serveStatus).includes(match.httpsPort)) {
    throw new CliError(
      `the endpoint for managed instance ${instance.instanceId} is exposed through Tailscale ` +
        'Funnel; disable Funnel before pairing',
    );
  }
  return `https://${dnsName}:${match.httpsPort}`;
}

/** Replace only localhost URL origins, retaining T3's pairing path and token. */
export function replaceLocalPairingUrls(output: string, endpoint: string): string {
  return output.replace(
    /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?[^\s"'<>]*/g,
    (localUrl) => {
      try {
        const parsed = new URL(localUrl);
        return `${endpoint}${parsed.pathname}${parsed.search}${parsed.hash}`;
      } catch {
        return localUrl;
      }
    },
  );
}

function optionValues(argv: readonly string[], option: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] !== option) continue;
    const value = argv[index + 1];
    if (value !== undefined) values.push(value);
  }
  return values;
}

function ambiguous(candidates: ManagedT3Process[]): CliError {
  return new CliError(
    'more than one running APM-managed T3 instance was found; choose one with ' +
      '`apm pair <instance-id>`:\n' +
      formatCandidates(candidates),
  );
}

function formatCandidates(candidates: ManagedT3Process[]): string {
  return candidates
    .map((candidate) => `  ${candidate.instanceId} (port ${candidate.port})`)
    .join('\n');
}

async function requireSuccess(
  resultPromise: Promise<PairProcessResult>,
  action: string,
): Promise<PairProcessResult> {
  let result: PairProcessResult;
  try {
    result = await resultPromise;
  } catch (error: unknown) {
    throw new CliError(`could not ${action}: ${describe(error)}`);
  }
  if (result.exitCode === 0 && result.signal === null) return result;
  throw new CliError(
    `could not ${action}: ` +
      (result.stderr.trim() ||
        (result.signal
          ? `command was killed by ${result.signal}`
          : `command exited with code ${result.exitCode ?? 'unknown'}`)),
  );
}

export function runProcess(argv: string[]): Promise<PairProcessResult> {
  const [command, ...args] = argv;
  if (command === undefined) return Promise.reject(new CliError('empty command argv'));
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => void (stdout += chunk));
    child.stderr.on('data', (chunk: string) => void (stderr += chunk));
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    // `exit` only means the process ended; inherited stdout/stderr descriptors
    // may still be open and delivering the one-time pairing token. `close`
    // fires after those streams close, so this is the safe capture boundary.
    child.once('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      resolve({ exitCode, signal, stdout, stderr });
    });
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
