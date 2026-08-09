import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveConfig, type DaemonConfig } from '../config.js';
import { createConfiguredTransports, readConfiguredTargets } from './config.js';

describe('target config', () => {
  let dataDir: string;
  let config: DaemonConfig;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-target-config-'));
    config = resolveConfig({ dataDir });
  });

  afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  it('treats a missing file as no configured remotes', () => {
    expect(readConfiguredTargets(config)).toEqual([]);
    expect(createConfiguredTransports(config)).toEqual([]);
  });

  it('creates only named SSH transports with the explicit approval state', () => {
    fs.writeFileSync(
      config.targetsFile,
      JSON.stringify({
        version: 1,
        targets: [
          {
            id: 'workstation',
            label: 'Workstation',
            transport: 'ssh',
            address: 'apm-workstation',
            approved: true,
          },
          {
            id: 'pending',
            label: 'Pending',
            transport: 'ssh',
            address: 'user@pending.example',
            approved: false,
          },
        ],
      }),
    );

    const transports = createConfiguredTransports(config);
    expect(transports.map((transport) => transport.target)).toMatchObject([
      { id: 'workstation', transport: 'ssh', approved: true },
      { id: 'pending', transport: 'ssh', approved: false },
    ]);
    expect(transports[0]?.target.identity.address).toBe('apm-workstation');
  });

  it('rejects duplicate, reserved and option-like target declarations', () => {
    const invalidFiles = [
      {
        version: 1,
        targets: [
          { id: 'same', label: 'One', transport: 'ssh', address: 'one', approved: true },
          { id: 'same', label: 'Two', transport: 'ssh', address: 'two', approved: true },
        ],
      },
      {
        version: 1,
        targets: [
          { id: 'local', label: 'Wrong', transport: 'ssh', address: 'host', approved: true },
        ],
      },
      {
        version: 1,
        targets: [
          {
            id: 'host',
            label: 'Wrong',
            transport: 'ssh',
            address: '-oProxyCommand=x',
            approved: true,
          },
        ],
      },
    ];

    for (const value of invalidFiles) {
      fs.writeFileSync(config.targetsFile, JSON.stringify(value));
      expect(() => readConfiguredTargets(config)).toThrow(/Invalid target config/);
    }
  });
});
