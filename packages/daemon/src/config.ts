import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface DaemonConfig {
  /** Root state dir, default ~/.local/share/apm (APM_DATA_DIR overrides). */
  dataDir: string;
  /** profiles.json — the human-editable profile store. */
  profilesFile: string;
  /** targets.json — explicitly configured and approved remote targets. */
  targetsFile: string;
  /** SQLite database for usage snapshots. */
  usageDb: string;
  /** Managed profile homes live under here, one dir per profile id. */
  homesDir: string;
  /** Per-profile collector caches (OAuth usage cache etc.). */
  cacheDir: string;
  /** Per-profile PATH shims that bind a provider CLI without binding the session. */
  shimsDir: string;
  /** Runtime rendezvous data (daemon.json with port + token). */
  runDir: string;
  runFile: string;
  logsDir: string;
  host: string;
  port: number;
  /** Per-start bearer token; never persisted anywhere except runFile (0600). */
  token: string;
  version: string;
}

export interface RunFileData {
  pid: number;
  host: string;
  port: number;
  token: string;
  url: string;
}

export const DEFAULT_PORT = 4747;

export function resolveConfig(
  overrides: Partial<Pick<DaemonConfig, 'dataDir' | 'port'>> = {},
): DaemonConfig {
  const home = os.homedir();
  const xdgData = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  const dataDir = path.resolve(
    overrides.dataDir || process.env.APM_DATA_DIR || path.join(xdgData, 'apm'),
  );
  const envPort = Number(process.env.APM_PORT);
  const validEnvPort = Number.isInteger(envPort) && envPort >= 1 && envPort <= 65535;
  const port = overrides.port ?? (validEnvPort ? envPort : DEFAULT_PORT);
  const runDir = path.join(dataDir, 'run');

  return {
    dataDir,
    profilesFile: path.join(dataDir, 'profiles.json'),
    targetsFile: path.join(dataDir, 'targets.json'),
    usageDb: path.join(dataDir, 'usage.db'),
    homesDir: path.join(dataDir, 'homes'),
    cacheDir: path.join(dataDir, 'cache'),
    shimsDir: path.join(dataDir, 'shims'),
    runDir,
    runFile: path.join(runDir, 'daemon.json'),
    logsDir: path.join(dataDir, 'logs'),
    host: '127.0.0.1',
    port,
    token: crypto.randomBytes(32).toString('hex'),
    version: '0.1.0',
  };
}

/** Create all state dirs with owner-only permissions. */
export function ensureDirs(config: DaemonConfig): void {
  for (const dir of [
    config.dataDir,
    config.homesDir,
    config.cacheDir,
    config.shimsDir,
    config.runDir,
    config.logsDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

export function writeRunFile(config: DaemonConfig): void {
  const data: RunFileData = {
    pid: process.pid,
    host: config.host,
    port: config.port,
    token: config.token,
    url: `http://${config.host}:${config.port}/?token=${config.token}`,
  };
  fs.writeFileSync(config.runFile, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

export function removeRunFile(config: DaemonConfig): void {
  try {
    fs.unlinkSync(config.runFile);
  } catch {
    /* already gone */
  }
}

/** Read the run file and verify the daemon behind it is actually alive. */
export function readLiveRunFile(config: Pick<DaemonConfig, 'runFile'>): RunFileData | null {
  let data: RunFileData;
  try {
    data = JSON.parse(fs.readFileSync(config.runFile, 'utf8')) as RunFileData;
  } catch {
    return null;
  }
  if (!data || typeof data.pid !== 'number' || typeof data.port !== 'number') return null;
  try {
    process.kill(data.pid, 0);
  } catch {
    return null;
  }
  return data;
}
