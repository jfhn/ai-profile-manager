import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DaemonHandle } from './server.js';
import { resolveConfig } from './config.js';
import { startDaemon } from './server.js';

describe('daemon product surface', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-server-'));
  const config = resolveConfig({ dataDir, port: 0 });
  let daemon: DaemonHandle;

  beforeAll(async () => {
    daemon = await startDaemon(config);
  });

  afterAll(async () => {
    await daemon.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('returns the profile and session overview shape', async () => {
    const response = await daemon.app.inject({
      method: 'GET',
      url: '/api/overview',
      headers: { authorization: `Bearer ${config.token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(Object.keys(response.json()).sort()).toEqual([
      'defaultProfileIds',
      'profiles',
      'providers',
      'sessions',
      'usage',
    ]);
  });

  it('does not register the removed service API', async () => {
    const response = await daemon.app.inject({
      method: 'GET',
      url: '/api/t' + '3',
      headers: { authorization: `Bearer ${config.token}` },
    });

    expect(response.statusCode).toBe(404);
  });
});
