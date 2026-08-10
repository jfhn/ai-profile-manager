import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { usageSnapshotSchema, type UsageSnapshot } from '@apm/shared';

interface SnapshotRow {
  profile_id: string;
  snapshot: string;
}

export class UsageDatabase {
  readonly database: DatabaseSync;

  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(file);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        snapshot TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS snapshots_profile_fetched_at
        ON snapshots(profile_id, fetched_at);
    `);
    fs.chmodSync(file, 0o600);
  }

  latest(): Record<string, UsageSnapshot> {
    const latest: Record<string, UsageSnapshot> = {};
    const rows = this.database
      .prepare('SELECT profile_id, snapshot FROM snapshots ORDER BY fetched_at ASC, id ASC')
      .all() as unknown as SnapshotRow[];
    for (const row of rows) {
      try {
        const parsed = usageSnapshotSchema.safeParse(JSON.parse(row.snapshot));
        if (!parsed.success || parsed.data.profileId !== row.profile_id) continue;
        latest[row.profile_id] = parsed.data;
      } catch {
        // Malformed historical rows remain in SQLite but never enter API/CLI output.
      }
    }
    return latest;
  }

  insert(snapshot: UsageSnapshot): void {
    this.database
      .prepare('INSERT INTO snapshots (profile_id, fetched_at, snapshot) VALUES (?, ?, ?)')
      .run(snapshot.profileId, snapshot.fetchedAt, JSON.stringify(snapshot));
  }

  deleteBefore(cutoff: string): void {
    this.database.prepare('DELETE FROM snapshots WHERE fetched_at < ?').run(cutoff);
  }
}
