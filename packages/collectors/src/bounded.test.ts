import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readTailBounded } from './bounded.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe('bounded reads', () => {
  it('reads only the tail of an oversized file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-bounded-'));
    dirs.push(dir);
    const file = path.join(dir, 'session.jsonl');
    fs.writeFileSync(file, `${'x'.repeat(8192)}END`);
    await expect(readTailBounded(file, 3)).resolves.toEqual({ text: 'END', truncated: true });
  });
});
