import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureDirs, readLiveRunFile, resolveConfig, writeRunFile } from './config.js';

const originalDataDir = process.env.APM_DATA_DIR;
const temporaryDirectories: string[] = [];

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.APM_DATA_DIR;
  else process.env.APM_DATA_DIR = originalDataDir;
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('resolveConfig', () => {
  it('resolves a relative APM_DATA_DIR once so every derived path is absolute', () => {
    process.env.APM_DATA_DIR = path.join('relative-apm-data', 'nested');

    const config = resolveConfig();

    expect(config.dataDir).toBe(path.resolve('relative-apm-data', 'nested'));
    for (const value of [
      config.profilesFile,
      config.targetsFile,
      config.usageDb,
      config.homesDir,
      config.cacheDir,
      config.runDir,
      config.runFile,
      config.logsDir,
    ]) {
      expect(path.isAbsolute(value)).toBe(true);
    }
  });

  it('also resolves a relative explicit data-dir override', () => {
    expect(resolveConfig({ dataDir: 'override-apm-data' }).dataDir).toBe(
      path.resolve('override-apm-data'),
    );
  });

  it('writes every field the CLI needs to reconnect to the live daemon', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-config-'));
    temporaryDirectories.push(dataDir);
    const config = resolveConfig({ dataDir, port: 54821 });
    ensureDirs(config);

    writeRunFile(config);

    const stored = JSON.parse(fs.readFileSync(config.runFile, 'utf8')) as Record<string, unknown>;
    expect(stored).toMatchObject({
      pid: process.pid,
      host: '127.0.0.1',
      port: 54821,
      token: config.token,
      url: `http://127.0.0.1:54821/?token=${config.token}`,
    });
    expect(readLiveRunFile(config)).toMatchObject(stored);
  });
});
