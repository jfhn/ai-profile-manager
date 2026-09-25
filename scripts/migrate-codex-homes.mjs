#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const SOCKET = path.join('app-server-control', 'app-server-control.sock');
const MARKER = '.apm-codex-home-migration';
const MAX_SOCKET_BYTES = 103;
const dataDir = path.resolve(
  process.env.APM_DATA_DIR ||
    path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'apm'),
);
const homesDir = path.join(dataDir, 'homes');
const profilesFile = path.join(dataDir, 'profiles.json');

function writeProfiles(store) {
  const temporary = path.join(dataDir, `.profiles.json.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, profilesFile);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function main() {
  const runFile = path.join(dataDir, 'run', 'daemon.json');
  if (fs.existsSync(runFile)) {
    const run = JSON.parse(fs.readFileSync(runFile, 'utf8'));
    if (!Number.isInteger(run.pid) || run.pid < 1) {
      throw new Error(`Invalid APM run file: ${runFile}`);
    }
    let running = true;
    try {
      process.kill(run.pid, 0);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
      running = false;
    }
    if (running) {
      throw new Error(`APM daemon is running: ${run.pid}`);
    }
  }
  if (!fs.existsSync(profilesFile)) {
    console.log('No profiles to migrate.');
    return;
  }

  const store = JSON.parse(fs.readFileSync(profilesFile, 'utf8'));
  if (![1, 2].includes(store?.version) || !Array.isArray(store.profiles)) {
    throw new Error(`Invalid APM profile store: ${profilesFile}`);
  }
  for (const profile of store.profiles) {
    if (
      typeof profile?.home !== 'string' ||
      typeof profile.provider !== 'string' ||
      typeof profile.homeKind !== 'string'
    ) {
      throw new Error(`Invalid APM profile store: ${profilesFile}`);
    }
  }

  const plans = [];
  const destinations = new Set();
  for (const profile of store.profiles) {
    if (profile.provider !== 'codex' || profile.homeKind !== 'managed') continue;
    if (!path.isAbsolute(profile.home)) {
      throw new Error(`Managed Codex home is not absolute: ${profile.home}`);
    }
    const from = path.resolve(profile.home);
    const oldName = path.basename(from);
    if (!UUID.test(oldName)) continue;
    if (path.dirname(from) !== homesDir) {
      throw new Error(`Managed Codex home is outside the homes directory: ${from}`);
    }
    const newName = oldName.replaceAll('-', '').slice(0, 16);
    const to = path.join(homesDir, newName);
    if (destinations.has(to)) throw new Error(`Codex home destination repeats: ${to}`);
    destinations.add(to);
    if (
      Buffer.byteLength(path.join(fs.realpathSync(homesDir), newName, SOCKET)) > MAX_SOCKET_BYTES
    ) {
      throw new Error(`Codex socket path is too long: ${to}`);
    }
    if (store.profiles.filter((other) => path.resolve(other.home) === from).length !== 1) {
      throw new Error(`Codex home is shared by multiple profiles: ${from}`);
    }
    for (const home of [from, to]) {
      if (fs.lstatSync(path.join(home, SOCKET), { throwIfNoEntry: false })?.isSocket()) {
        throw new Error(`Codex control socket still exists: ${home}`);
      }
    }
    const source = fs.lstatSync(from, { throwIfNoEntry: false });
    const target = fs.lstatSync(to, { throwIfNoEntry: false });
    const resumed = source?.isSymbolicLink() && target?.isDirectory();
    const moved =
      !source &&
      target?.isDirectory() &&
      fs.existsSync(path.join(to, MARKER)) &&
      fs.readFileSync(path.join(to, MARKER), 'utf8') === `${from}\n`;
    if (resumed) {
      if (fs.realpathSync(from) !== fs.realpathSync(to)) {
        throw new Error(`Codex home alias points elsewhere: ${from}`);
      }
    } else if (!moved && (!source?.isDirectory() || target)) {
      throw new Error(`Codex home cannot be moved: ${from}`);
    }
    if (source?.isDirectory()) {
      const marker = path.join(from, MARKER);
      if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') !== `${from}\n`) {
        throw new Error(`Codex home migration marker differs: ${marker}`);
      }
    }
    plans.push({ profile, from, to, resumed, moved });
  }

  for (const { profile, from, to, resumed, moved } of plans) {
    if (!resumed && !moved) {
      const marker = path.join(from, MARKER);
      if (!fs.existsSync(marker)) {
        fs.writeFileSync(marker, `${from}\n`, { flag: 'wx', mode: 0o600 });
      }
      fs.renameSync(from, to);
    }
    if (!resumed) {
      try {
        fs.symlinkSync(to, from, 'dir');
      } catch (error) {
        if (!moved) {
          fs.renameSync(to, from);
          fs.rmSync(path.join(from, MARKER), { force: true });
        }
        throw error;
      }
    }
    profile.home = to;
    try {
      writeProfiles(store);
    } catch (error) {
      profile.home = from;
      if (!resumed) {
        fs.unlinkSync(from);
        if (!moved) {
          fs.renameSync(to, from);
          fs.rmSync(path.join(from, MARKER), { force: true });
        }
      }
      throw error;
    }
    fs.rmSync(path.join(to, MARKER), { force: true });
    console.log(`${path.basename(from)} -> ${path.basename(to)}`);
  }
  console.log(`Migrated ${plans.length} Codex home${plans.length === 1 ? '' : 's'}.`);
}

try {
  main();
} catch (error) {
  console.error(`apm migration: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
