#!/usr/bin/env node
/**
 * apm — AI profile manager CLI.
 *
 *   apm [start] [--port N] [--no-open] [--foreground]   start or reuse the daemon, open the UI
 *   apm run <profile> <app> [args...]                   run an app bound to a profile
 *   apm attach <session>                                attach to a running session
 *   apm sessions                                        list sessions
 *   apm status                                          show daemon status
 *   apm stop                                            stop the daemon
 *
 * apm flags precede the positionals; everything after <app> is passed to the
 * app verbatim (`--` supported as an optional escape hatch).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readLiveRunFile, resolveConfig, ensureDirs, DEFAULT_PORT } from './config.js';
import { startDaemon } from './server.js';
import {
  attachCommand,
  runCommand,
  sessionsCommand,
  statusCommand,
  stopCommand,
} from './cli/commands.js';

interface StartFlags {
  port: number;
  open: boolean;
  foreground: boolean;
}

function parseStartFlags(argv: string[]): StartFlags {
  const flags: StartFlags = { port: DEFAULT_PORT, open: true, foreground: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--no-open') flags.open = false;
    else if (arg === '--foreground') flags.foreground = true;
    else if (arg === '--port') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1 || value > 65535) fail(`invalid --port value`);
      flags.port = value;
    } else fail(`unknown flag: ${arg}`);
  }
  if (process.env.APM_PORT && flags.port === DEFAULT_PORT) flags.port = Number(process.env.APM_PORT);
  return flags;
}

export function fail(message: string): never {
  console.error(`apm: ${message}`);
  process.exit(1);
}

function openBrowser(url: string): void {
  const child = spawn('sh', ['-c', `xdg-open "$1" 2>/dev/null || wslview "$1" 2>/dev/null`, '_', url], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

async function startCommand(argv: string[]): Promise<void> {
  const flags = parseStartFlags(argv);
  const config = resolveConfig({ port: flags.port });

  const live = readLiveRunFile(config);
  if (live) {
    console.log(`apm daemon already running (pid ${live.pid})`);
    console.log(live.url);
    if (flags.open) openBrowser(live.url);
    return;
  }

  if (flags.foreground) {
    const handle = await startDaemon(config);
    console.log(`apm daemon listening on ${handle.url}`);
    if (flags.open) openBrowser(handle.url);
    return; // keeps running until SIGINT
  }

  // Detached: re-exec ourselves as the daemon process, wait for the run file.
  ensureDirs(config);
  const self = fileURLToPath(import.meta.url);
  const logFile = path.join(config.logsDir, 'daemon.log');
  const log = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [self, '__daemon', '--port', String(config.port)], {
    detached: true,
    stdio: ['ignore', log, log],
  });
  child.unref();

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const run = readLiveRunFile(config);
    if (run && run.pid === child.pid) {
      console.log(`apm daemon started (pid ${run.pid})`);
      console.log(run.url);
      if (flags.open) openBrowser(run.url);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  fail(`daemon did not come up within 15s — see ${logFile}`);
}

async function daemonMain(argv: string[]): Promise<void> {
  const flags = parseStartFlags(argv.filter((a) => a !== '--no-open'));
  const config = resolveConfig({ port: flags.port });
  await startDaemon(config);
}

async function main(): Promise<void> {
  const [command = 'start', ...rest] = process.argv.slice(2);
  switch (command) {
    case 'start':
      return startCommand(rest);
    case '__daemon':
      return daemonMain(rest);
    case 'run':
      return runCommand(rest);
    case 'attach':
      return attachCommand(rest);
    case 'sessions':
      return sessionsCommand(rest);
    case 'status':
      return statusCommand(rest);
    case 'stop':
      return stopCommand(rest);
    case '--help':
    case '-h':
    case 'help':
      console.log(
        `usage: apm [start|run|attach|sessions|status|stop]\n` +
          `  apm start [--port N] [--no-open] [--foreground]\n` +
          `  apm run <profile> <app> [args...]\n` +
          `  apm attach <session>\n`,
      );
      return;
    default:
      fail(`unknown command: ${command}`);
  }
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
