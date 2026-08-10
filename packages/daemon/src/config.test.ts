import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveConfig } from './config.js';

const originalDataDir = process.env.APM_DATA_DIR;

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.APM_DATA_DIR;
  else process.env.APM_DATA_DIR = originalDataDir;
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
      config.t3Dir,
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
});
