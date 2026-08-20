import fsp from 'node:fs/promises';
import path from 'node:path';
import { readJsonBounded } from './bounded.js';
import { isRecord, normalizeTimestamp, readString, safeReason } from './normalize.js';

/** A provider's last usable usage payload plus its last recorded failure. */
export interface UsageCache {
  usage: unknown | null;
  updatedAt: string | null;
  ageMs: number;
  errorAt: string | null;
  errorAgeMs: number;
  errorReason: string | null;
}

export async function readUsageCache(file: string, nowMs: number): Promise<UsageCache> {
  const data = await readJsonBounded(file);
  const record = isRecord(data) ? data : null;
  const updatedAt = normalizeTimestamp(record?.updatedAt);
  const errorAt = normalizeTimestamp(record?.lastErrorAt);
  const updatedMs = Date.parse(updatedAt ?? '');
  const errorMs = Date.parse(errorAt ?? '');
  return {
    usage: record?.usage ?? null,
    updatedAt,
    ageMs: Number.isFinite(updatedMs) ? nowMs - updatedMs : Infinity,
    errorAt,
    errorAgeMs: Number.isFinite(errorMs) ? nowMs - errorMs : Infinity,
    errorReason: readString(record?.lastErrorReason),
  };
}

export async function writeUsageCache(
  file: string,
  data: { updatedAt: string; usage: unknown },
): Promise<void> {
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await fsp.chmod(file, 0o600);
  } catch {
    // Cache writes are best-effort.
  }
}

export async function writeUsageError(
  file: string,
  cache: UsageCache,
  reason: string,
  nowMs: number,
): Promise<void> {
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(
      file,
      `${JSON.stringify({ updatedAt: cache.updatedAt, usage: cache.usage, lastErrorAt: new Date(nowMs).toISOString(), lastErrorReason: safeReason(reason) }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await fsp.chmod(file, 0o600);
  } catch {
    // Cache writes are best-effort.
  }
}
