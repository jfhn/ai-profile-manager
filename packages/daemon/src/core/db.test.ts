import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { UsageSnapshot } from '@apm/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { UsageDatabase } from './db.js';

const temporaryDirectories: string[] = [];
const openDatabases: UsageDatabase[] = [];

afterEach(() => {
  for (const db of openDatabases.splice(0)) db.database.close();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('UsageDatabase.latest', () => {
  it('keeps malformed JSON and structurally invalid rows out of runtime output without rewriting them', () => {
    const db = temporaryDatabase();
    insertRaw(db, 'malformed-json', '2026-01-01T00:00:00.000Z', '{');
    insertRaw(db, 'invalid-shape', '2026-01-01T00:01:00.000Z', {
      profileId: 'invalid-shape',
    });

    expect(db.latest()).toEqual({});
    expect(rowCount(db)).toBe(2);
  });

  it.each([
    ['window percentages', { windows: [window({ usedPercent: 101 })] }],
    ['window reset timestamp', { windows: [window({ resetAt: 'tomorrow' })] }],
    ['snapshot timestamp', { fetchedAt: 'yesterday' }],
    ['underlying-data timestamp', { dataUpdatedAt: 'recently' }],
    ['cache status', { cacheStatus: 'fresh' }],
    ['failure status', { failureKind: 'network' }],
    ['retry delay', { retryAfterSeconds: -1 }],
  ])('omits a row with invalid %s', (_description, override) => {
    const db = temporaryDatabase();
    const profileId = 'profile';
    insertRaw(db, profileId, '2026-01-01T00:00:00.000Z', snapshot(profileId, override));

    expect(db.latest()).toEqual({});
    expect(rowCount(db)).toBe(1);
  });

  it('requires the snapshot profile id to match its SQLite row', () => {
    const db = temporaryDatabase();
    insertRaw(db, 'row-profile', '2026-01-01T00:00:00.000Z', snapshot('different-profile'));

    expect(db.latest()).toEqual({});
  });

  it('allows a later valid row to supersede an invalid historical row', () => {
    const db = temporaryDatabase();
    const profileId = 'work/個人';
    insertRaw(db, profileId, '2026-01-01T00:00:00.000Z', {
      ...snapshot(profileId),
      cacheStatus: 'invalid',
    });
    const valid = snapshot(profileId, {
      fetchedAt: '2026-01-01T00:01:00.000Z',
      source: 'later valid source',
    });
    insertRaw(db, profileId, '2026-01-01T00:01:00.000Z', valid);

    expect(db.latest()).toEqual({ [profileId]: valid });
    expect(rowCount(db)).toBe(2);
  });
});

function temporaryDatabase(): UsageDatabase {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-usage-db-test-'));
  temporaryDirectories.push(directory);
  const db = new UsageDatabase(path.join(directory, 'usage.db'));
  openDatabases.push(db);
  return db;
}

function insertRaw(db: UsageDatabase, profileId: string, fetchedAt: string, value: unknown): void {
  db.database
    .prepare('INSERT INTO snapshots (profile_id, fetched_at, snapshot) VALUES (?, ?, ?)')
    .run(profileId, fetchedAt, typeof value === 'string' ? value : JSON.stringify(value));
}

function rowCount(db: UsageDatabase): number {
  const row = db.database.prepare('SELECT COUNT(*) AS count FROM snapshots').get() as {
    count: number;
  };
  return row.count;
}

function snapshot(profileId: string, override: Record<string, unknown> = {}): UsageSnapshot {
  return {
    profileId,
    windows: [window()],
    fetchedAt: '2026-01-01T00:00:00.000Z',
    source: 'test source',
    cacheStatus: 'live',
    dataUpdatedAt: null,
    stale: false,
    staleReason: null,
    failureKind: null,
    error: null,
    planType: null,
    retryAfterSeconds: null,
    ...override,
  } as UsageSnapshot;
}

function window(override: Record<string, unknown> = {}) {
  return {
    id: 'weekly',
    label: '7d',
    usedPercent: 25,
    remainingPercent: 75,
    resetAt: null,
    ...override,
  };
}
