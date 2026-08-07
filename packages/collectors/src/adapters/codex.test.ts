import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codexAdapter } from './codex.js';

const dirs: string[] = [];
const now = Date.parse('2025-01-10T00:00:00Z');
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function home(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-codex-'));
  dirs.push(dir);
  return dir;
}

function writeSession(homeDir: string, timestamp: string, limits: unknown): void {
  const file = path.join(homeDir, 'sessions', '2025', '01', 'x.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `partial\n${JSON.stringify({ timestamp, payload: { rate_limits: limits } })}\n`);
  fs.utimesSync(file, now / 1000, now / 1000);
}

describe('codex adapter', () => {
  it('uses the newest parseable record and emits only weekly during rollout', async () => {
    const dir = home();
    writeSession(dir, '2025-01-09T23:00:00Z', { primary: { used_percent: 20 }, secondary: { used_percent: 40, reset_at: '2025-01-12T00:00:00Z' }, plan_type: 'plus' });
    const result = await codexAdapter.collectUsage({ home: dir, cacheDir: path.join(dir, 'cache'), allowNetwork: false, now });
    expect(result.windows).toEqual([expect.objectContaining({ id: 'weekly', usedPercent: 40 })]);
    expect(result.planType).toBe('plus');
    expect(result.cacheStatus).toBe('live');
  });

  it('marks old records without future resets stale and handles absent data', async () => {
    const dir = home();
    writeSession(dir, '2025-01-01T00:00:00Z', { primary: { used_percent: 20 }, secondary: { used_percent: 40 } });
    const stale = await codexAdapter.collectUsage({ home: dir, cacheDir: path.join(dir, 'cache'), allowNetwork: false, now });
    expect(stale).toMatchObject({ cacheStatus: 'stale-cache', stale: true });
    const absent = await codexAdapter.collectUsage({ home: path.join(dir, 'missing'), cacheDir: path.join(dir, 'cache'), allowNetwork: false, now });
    expect(absent).toMatchObject({ windows: [], cacheStatus: 'live', stale: false, error: null });
  });
});
