import fs from 'node:fs/promises';
import path from 'node:path';

export interface BoundedText {
  text: string;
  truncated: boolean;
}

export interface WalkFilesOptions {
  accept?: (name: string) => boolean;
  maxFiles?: number;
  newestFirst?: boolean;
}

/** Read a provider-owned text file without loading an unbounded payload. */
export async function readTextBounded(
  file: string,
  maxBytes = 4 * 1024 * 1024,
): Promise<BoundedText | null> {
  return readWindow(file, maxBytes, false);
}

/** Read the trailing section of an append-only provider-owned file. */
export async function readTailBounded(
  file: string,
  maxBytes = 4 * 1024 * 1024,
): Promise<BoundedText | null> {
  return readWindow(file, maxBytes, true);
}

export async function readJsonBounded(
  file: string,
  maxBytes = 4 * 1024 * 1024,
): Promise<unknown | null> {
  const text = await readTextBounded(file, maxBytes);
  if (!text || text.truncated || !text.text) {
    return null;
  }
  try {
    return JSON.parse(text.text) as unknown;
  } catch {
    return null;
  }
}

/** Bounded depth-first walk. Descending names keep timestamped session trees recent-first. */
export async function walkFilesBounded(
  root: string,
  options: WalkFilesOptions = {},
): Promise<string[]> {
  const accept = options.accept ?? (() => true);
  const maxFiles = positiveInt(options.maxFiles, 5_000);
  const files: string[] = [];

  const visit = async (dir: string, depth: number): Promise<void> => {
    if (files.length >= maxFiles || depth > 24) {
      return;
    }
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
    if (!entries) {
      return;
    }
    entries.sort((a, b) =>
      options.newestFirst ? b.name.localeCompare(a.name) : a.name.localeCompare(b.name),
    );
    for (const entry of entries.slice(0, 10_000)) {
      if (files.length >= maxFiles) {
        return;
      }
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(file, depth + 1);
      } else if (entry.isFile() && accept(entry.name)) {
        files.push(file);
      }
    }
  };

  await visit(root, 0);
  return files;
}

export async function statOrNull(
  file: string,
): Promise<Awaited<ReturnType<typeof fs.stat>> | null> {
  return fs.stat(file).catch(() => null);
}

async function readWindow(
  file: string,
  maxBytes: number,
  tail: boolean,
): Promise<BoundedText | null> {
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(file, 'r');
    const stat = await handle.stat();
    const size = Number(stat.size);
    if (!Number.isFinite(size) || size <= 0) {
      return { text: '', truncated: false };
    }
    const cap = positiveInt(maxBytes, 4 * 1024 * 1024);
    const length = Math.min(size, cap);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, tail ? size - length : 0);
    return { text: buffer.toString('utf8', 0, bytesRead), truncated: size > cap };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}
