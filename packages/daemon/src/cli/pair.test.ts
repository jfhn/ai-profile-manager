import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { APM_MANAGED_T3_INSTANCE_ENV } from '../t3/identity.js';
import {
  PAIR_TTL,
  discoverManagedT3Processes,
  managedT3ProcessFromArgv,
  replaceLocalPairingUrls,
  resolvePublishedEndpoint,
  runPair,
  runProcess,
  selectManagedT3Process,
  t3PairArgv,
  type ManagedT3Process,
  type PairProcessResult,
  type ProcessAttribution,
  type ProcessOwner,
} from './pair.js';

const T3_DIR = '/home/dev/.local/share/apm/t3';
const INSTANCE = processFor('instance-a', 4800, 101);
const UID = 1000;
const OWNER: ProcessOwner = { realUid: UID, effectiveUid: UID };
const ATTRIBUTION: ProcessAttribution = {
  realUid: UID,
  effectiveUid: UID,
  instanceMarker: INSTANCE.instanceId,
};
const DNS_NAME = 'dev-box.tailnet.ts.net';
const STATUS = JSON.stringify({ Self: { DNSName: `${DNS_NAME}.` } });

function processFor(instanceId: string, port: number, pid: number): ManagedT3Process {
  return { pid, instanceId, port, baseDir: path.join(T3_DIR, instanceId) };
}

function result(overrides: Partial<PairProcessResult> = {}): PairProcessResult {
  return { exitCode: 0, signal: null, stdout: '', stderr: '', ...overrides };
}

function serveStatus(entries: Array<{ https: number; backend: number }>, funnel: number[] = []) {
  return JSON.stringify({
    Web: Object.fromEntries(
      entries.map(({ https, backend }) => [
        `${DNS_NAME}:${https}`,
        { Handlers: { '/': { Proxy: `http://127.0.0.1:${backend}` } } },
      ]),
    ),
    AllowFunnel: Object.fromEntries(funnel.map((port) => [`${DNS_NAME}:${port}`, true])),
  });
}

describe('managed T3 process selection', () => {
  it('automatically selects exactly one running managed instance', () => {
    expect(selectManagedT3Process([INSTANCE])).toBe(INSTANCE);
  });

  it('gives an actionable error when none is running', () => {
    expect(() => selectManagedT3Process([])).toThrow(/start one from the hub dashboard/);
  });

  it('never guesses between several instances and lists exact selectors', () => {
    const other = processFor('instance-b', 4801, 102);
    expect(() => selectManagedT3Process([other, INSTANCE])).toThrow(/apm pair <instance-id>/);
    expect(() => selectManagedT3Process([other, INSTANCE])).toThrow(/instance-a \(port 4800\)/);
    expect(selectManagedT3Process([other, INSTANCE], 'instance-b')).toBe(other);
    expect(() => selectManagedT3Process([other, INSTANCE], 'missing')).toThrow(/running instances/);
  });

  it('refuses duplicate live processes even when an id was supplied', () => {
    expect(() =>
      selectManagedT3Process([INSTANCE, { ...INSTANCE, pid: 999 }], INSTANCE.instanceId),
    ).toThrow(/more than one running/);
  });
});

describe('managed process recognition', () => {
  it('accepts the exact serve argv and only immediate children of the managed root', () => {
    expect(
      managedT3ProcessFromArgv(
        101,
        ['node', '/opt/t3/cli.js', 'serve', '--port', '4800', '--base-dir', INSTANCE.baseDir],
        T3_DIR,
        ATTRIBUTION,
        OWNER,
      ),
    ).toEqual(INSTANCE);

    expect(
      managedT3ProcessFromArgv(
        101,
        ['t3', 'serve', '--port', '4800', '--base-dir', path.join(T3_DIR, 'nested', 'child')],
        T3_DIR,
        { ...ATTRIBUTION, instanceMarker: 'child' },
        OWNER,
      ),
    ).toBeNull();
    expect(
      managedT3ProcessFromArgv(
        101,
        ['t3', 'serve', '--port', '4800', '--base-dir', '/tmp/unmanaged'],
        T3_DIR,
        { ...ATTRIBUTION, instanceMarker: 'unmanaged' },
        OWNER,
      ),
    ).toBeNull();
  });

  it('rejects malformed ports, missing flags, duplicate flags and non-serve processes', () => {
    expect(managedT3ProcessFromArgv(1, ['t3', 'pair'], T3_DIR, ATTRIBUTION, OWNER)).toBeNull();
    expect(
      managedT3ProcessFromArgv(
        1,
        ['t3', 'serve', '--port', 'nope', '--base-dir', INSTANCE.baseDir],
        T3_DIR,
        ATTRIBUTION,
        OWNER,
      ),
    ).toBeNull();
    expect(
      managedT3ProcessFromArgv(
        1,
        ['t3', 'serve', '--port', '4800', '--port', '4801', '--base-dir', INSTANCE.baseDir],
        T3_DIR,
        ATTRIBUTION,
        OWNER,
      ),
    ).toBeNull();
  });

  it('rejects wrong-user, missing-marker, wrong-marker and non-T3 candidates', () => {
    const argv = ['python', 'serve', '--port', '4800', '--base-dir', INSTANCE.baseDir];
    expect(
      managedT3ProcessFromArgv(101, argv, T3_DIR, { ...ATTRIBUTION, realUid: UID + 1 }, OWNER),
    ).toBeNull();
    expect(
      managedT3ProcessFromArgv(101, argv, T3_DIR, { ...ATTRIBUTION, effectiveUid: UID + 1 }, OWNER),
    ).toBeNull();
    expect(managedT3ProcessFromArgv(101, argv, T3_DIR, null, OWNER)).toBeNull();
    expect(
      managedT3ProcessFromArgv(
        101,
        argv,
        T3_DIR,
        { ...ATTRIBUTION, instanceMarker: 'another-instance' },
        OWNER,
      ),
    ).toBeNull();
  });

  it('reads NUL-delimited argv from a proc-like tree and ignores malformed entries', () => {
    const procDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-pair-proc-'));
    tempDirs.push(procDir);
    writeProcCandidate(
      procDir,
      101,
      ['t3', 'serve', '--port', '4800', '--base-dir', INSTANCE.baseDir],
      UID,
      INSTANCE.instanceId,
    );
    // Right argv shape, but a generic process with no APM launch marker.
    writeProcCandidate(
      procDir,
      102,
      ['python', 'serve', '--port', '4801', '--base-dir', path.join(T3_DIR, 'not-t3')],
      UID,
      null,
    );
    // A marker does not override the target-user ownership boundary.
    writeProcCandidate(
      procDir,
      103,
      ['t3', 'serve', '--port', '4802', '--base-dir', path.join(T3_DIR, 'wrong-user')],
      UID + 1,
      'wrong-user',
    );
    // Same user and T3-shaped argv, but marker/base-dir disagreement.
    writeProcCandidate(
      procDir,
      104,
      ['t3', 'serve', '--port', '4803', '--base-dir', path.join(T3_DIR, 'wrong-marker')],
      UID,
      'another-instance',
    );
    // Attribution files disappearing or being unreadable fails closed.
    fs.mkdirSync(path.join(procDir, '105'));
    fs.writeFileSync(
      path.join(procDir, '105', 'cmdline'),
      ['t3', 'serve', '--port', '4804', '--base-dir', path.join(T3_DIR, 'unattributed')].join('\0'),
    );
    fs.mkdirSync(path.join(procDir, 'self'));

    expect(discoverManagedT3Processes(T3_DIR, procDir, OWNER)).toEqual([INSTANCE]);
  });
});

describe('published endpoint resolution', () => {
  it('matches the selected backend and presents its actual HTTPS listener', () => {
    expect(
      resolvePublishedEndpoint(INSTANCE, STATUS, serveStatus([{ https: 8443, backend: 4800 }])),
    ).toBe(`https://${DNS_NAME}:8443`);
  });

  it('refuses absent, ambiguous and funnelled endpoint mappings', () => {
    expect(() => resolvePublishedEndpoint(INSTANCE, STATUS, serveStatus([]))).toThrow(
      /no published Tailscale Serve endpoint/,
    );
    expect(() =>
      resolvePublishedEndpoint(
        INSTANCE,
        STATUS,
        serveStatus([
          { https: 8443, backend: 4800 },
          { https: 8444, backend: 4800 },
        ]),
      ),
    ).toThrow(/more than one published endpoint/);
    expect(() =>
      resolvePublishedEndpoint(
        INSTANCE,
        STATUS,
        serveStatus([{ https: 8443, backend: 4800 }], [8443]),
      ),
    ).toThrow(/Funnel/);
  });
});

describe('pair workflow', () => {
  it('is dispatched by the real CLI entry point without starting a daemon', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-pair-dispatch-'));
    tempDirs.push(dataDir);
    const main = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'main.ts');
    const invoked = spawnSync(process.execPath, ['--import', 'tsx', main, 'pair'], {
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, APM_DATA_DIR: dataDir },
    });

    expect(invoked.status).toBe(1);
    expect(invoked.stderr).toContain('no running APM-managed T3 instance');
    expect(fs.existsSync(path.join(dataDir, 'run', 'daemon.json'))).toBe(false);
  });

  it('uses the exact base dir and TTL, and emits a published direct pairing link', async () => {
    const calls: string[][] = [];
    let stdout = '';
    let stderr = '';
    const token = 'one-time-secret';
    const run = async (argv: string[]): Promise<PairProcessResult> => {
      calls.push(argv);
      if (argv[0] === 'tailscale' && argv[1] === 'status') return result({ stdout: STATUS });
      if (argv[0] === 'tailscale') {
        return result({ stdout: serveStatus([{ https: 8443, backend: 4800 }]) });
      }
      return result({
        stdout: `Pair here: http://localhost:4800/pair?token=${token}#owner\n`,
      });
    };

    await runPair(
      {},
      {
        t3Dir: T3_DIR,
        listProcesses: () => [INSTANCE],
        run,
        writeStdout: (text) => void (stdout += text),
        writeStderr: (text) => void (stderr += text),
      },
    );

    expect(calls).toEqual([
      ['tailscale', 'status', '--json'],
      ['tailscale', 'serve', 'status', '--json'],
      ['t3', 'pair', '--base-dir', INSTANCE.baseDir, '--ttl', '15m'],
    ]);
    expect(t3PairArgv(INSTANCE.baseDir)).toEqual(calls[2]);
    expect(PAIR_TTL).toBe('15m');
    expect(stdout).toContain(`Published endpoint: https://${DNS_NAME}:8443`);
    expect(stdout).toContain(`https://${DNS_NAME}:8443/pair?token=${token}#owner`);
    expect(stdout).not.toContain('localhost');
    expect(stderr).toBe('');
  });

  it('does not persist or log the token; its sole sink is the injected terminal', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-pair-data-'));
    tempDirs.push(dataDir);
    const t3Dir = path.join(dataDir, 't3');
    const logsDir = path.join(dataDir, 'logs');
    fs.mkdirSync(t3Dir, { recursive: true });
    fs.mkdirSync(logsDir);
    fs.writeFileSync(path.join(t3Dir, 'instances.json'), '{"version":1,"instances":[]}\n');
    fs.writeFileSync(path.join(logsDir, 'daemon.log'), 'before\n');
    const managed = { ...INSTANCE, baseDir: path.join(t3Dir, INSTANCE.instanceId) };
    const token = 'terminal-only-secret';
    let terminal = '';

    await runPair(
      {},
      {
        t3Dir,
        listProcesses: () => [managed],
        run: async (argv) => {
          if (argv[0] === 't3') return result({ stdout: `token: ${token}\n` });
          if (argv[1] === 'status') return result({ stdout: STATUS });
          return result({ stdout: serveStatus([{ https: 8443, backend: 4800 }]) });
        },
        writeStdout: (text) => void (terminal += text),
        writeStderr: (text) => void (terminal += text),
      },
    );

    expect(terminal).toContain(token);
    expect(fs.readFileSync(path.join(t3Dir, 'instances.json'), 'utf8')).toBe(
      '{"version":1,"instances":[]}\n',
    );
    expect(fs.readFileSync(path.join(logsDir, 'daemon.log'), 'utf8')).toBe('before\n');
    expect(allFileText(dataDir)).not.toContain(token);
  });

  it('keeps captured failure output confined to the explicit terminal sinks', async () => {
    let stdout = '';
    let stderr = '';
    await expect(
      runPair(
        {},
        {
          t3Dir: T3_DIR,
          listProcesses: () => [INSTANCE],
          run: async (argv) => {
            if (argv[0] === 't3') {
              return result({ exitCode: 2, stdout: 'partial token\n', stderr: 'pair failed\n' });
            }
            if (argv[1] === 'status') return result({ stdout: STATUS });
            return result({ stdout: serveStatus([{ https: 8443, backend: 4800 }]) });
          },
          writeStdout: (text) => void (stdout += text),
          writeStderr: (text) => void (stderr += text),
        },
      ),
    ).rejects.toThrow(/exited with code 2/);
    expect(stdout).toBe('partial token\n');
    expect(stderr).toBe('pair failed\n');
  });

  it('drains exact large failure output through the real CLI entry point', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-pair-failure-'));
    tempDirs.push(dataDir);
    const t3Dir = path.join(dataDir, 't3');
    const binDir = path.join(dataDir, 'bin');
    const instanceId = 'live-instance';
    const baseDir = path.join(t3Dir, instanceId);
    fs.mkdirSync(baseDir, { recursive: true });
    fs.mkdirSync(binDir);

    const stdoutPayload = 'o'.repeat(1_000_000);
    const stderrPayload = 'e'.repeat(1_000_000);
    writeExecutable(
      path.join(binDir, 'tailscale'),
      'const args = process.argv.slice(2);\n' +
        `const status = ${JSON.stringify(STATUS)};\n` +
        `const serve = ${JSON.stringify(serveStatus([{ https: 8443, backend: 4800 }]))};\n` +
        "process.stdout.write(args[0] === 'status' ? status : serve);\n",
    );
    writeExecutable(
      path.join(binDir, 't3'),
      `process.stdout.write('o'.repeat(${stdoutPayload.length}));\n` +
        `process.stderr.write('e'.repeat(${stderrPayload.length}));\n` +
        'process.exitCode = 2;\n',
    );

    const server = spawn(
      process.execPath,
      [
        '-e',
        'setInterval(() => undefined, 1000)',
        'serve',
        '--port',
        '4800',
        '--base-dir',
        baseDir,
      ],
      {
        stdio: 'ignore',
        env: { ...process.env, [APM_MANAGED_T3_INSTANCE_ENV]: instanceId },
      },
    );
    liveChildren.push(server);

    const main = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'main.ts');
    const invoked = spawnSync(process.execPath, ['--import', 'tsx', main, 'pair'], {
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 3_000_000,
      env: {
        ...process.env,
        APM_DATA_DIR: dataDir,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      },
    });

    expect(invoked.error).toBeUndefined();
    expect(invoked.status).toBe(1);
    expect(invoked.stdout).toBe(stdoutPayload);
    expect(invoked.stderr).toBe(`${stderrPayload}apm: t3 pair exited with code 2\n`);
  });
});

describe('pair subprocess capture', () => {
  it('waits for inherited stdout and stderr pipes to close after the child exits', async () => {
    const delayedWriter =
      "setTimeout(() => { process.stdout.write('late stdout\\n'); " +
      "process.stderr.write('late stderr\\n'); }, 75)";
    const parent =
      "const { spawn } = require('node:child_process'); " +
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(delayedWriter)}], ` +
      "{ stdio: ['ignore', 1, 2] }); child.unref()";

    const captured = await runProcess([process.execPath, '-e', parent]);

    expect(captured).toEqual({
      exitCode: 0,
      signal: null,
      stdout: 'late stdout\n',
      stderr: 'late stderr\n',
    });
  });

  it('rejects a spawn error only once even though close follows it', async () => {
    await expect(runProcess(['/definitely/not/an/apm-command'])).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

describe('pairing URL presentation', () => {
  it('preserves paths, token queries and fragments for every local origin form', () => {
    const endpoint = 'https://dev-box.tailnet.ts.net:8443';
    expect(
      replaceLocalPairingUrls(
        'http://localhost:4800/pair?token=a%2Bb#owner https://127.0.0.1/x?q=2 https://[::1]:9/y',
        endpoint,
      ),
    ).toBe(`${endpoint}/pair?token=a%2Bb#owner ${endpoint}/x?q=2 ${endpoint}/y`);
  });
});

const tempDirs: string[] = [];
const liveChildren: ChildProcess[] = [];
afterEach(() => {
  for (const child of liveChildren.splice(0)) child.kill('SIGKILL');
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeExecutable(file: string, source: string): void {
  fs.writeFileSync(file, `#!/usr/bin/env node\n${source}`, { mode: 0o700 });
}

function writeProcCandidate(
  procDir: string,
  pid: number,
  argv: string[],
  uid: number,
  marker: string | null,
): void {
  const processDir = path.join(procDir, String(pid));
  fs.mkdirSync(processDir);
  fs.writeFileSync(path.join(processDir, 'cmdline'), [...argv, ''].join('\0'));
  fs.writeFileSync(
    path.join(processDir, 'status'),
    `Name:\tt3\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`,
  );
  fs.writeFileSync(
    path.join(processDir, 'environ'),
    `PATH=/bin\0${marker === null ? '' : `${APM_MANAGED_T3_INSTANCE_ENV}=${marker}\0`}`,
  );
}

function allFileText(root: string): string {
  const contents: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) contents.push(allFileText(child));
    else contents.push(fs.readFileSync(child, 'utf8'));
  }
  return contents.join('\n');
}
