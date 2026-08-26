import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCliToolService } from './tools.js';

let tempDir: string | null = null;

afterEach(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe('CLI tool service', () => {
  it('lists one shared executable and updates it without a profile binding', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-tools-'));
    const binDir = path.join(tempDir, 'bin');
    const shimsDir = path.join(tempDir, 'apm-shims');
    fs.mkdirSync(binDir);
    fs.mkdirSync(shimsDir);
    const versionFile = path.join(tempDir, 'version');
    const executable = path.join(binDir, 'codex');
    fs.writeFileSync(versionFile, 'codex-cli 1.0.0');
    fs.writeFileSync(
      executable,
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  IFS= read -r version < "$TOOL_VERSION_FILE"
  printf '%s' "$version"
  exit 0
fi
if [ "$1" = "update" ]; then
  [ -z "\${CODEX_HOME+x}" ] || exit 9
  printf 'codex-cli 2.0.0' > "$TOOL_VERSION_FILE"
  printf 'updated with the detected installer\n'
  exit 0
fi
exit 2
`,
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(shimsDir, 'codex'), '#!/bin/sh\nexit 8\n', { mode: 0o755 });

    const service = createCliToolService(
      {
        PATH: `${shimsDir}${path.delimiter}${binDir}`,
        TOOL_VERSION_FILE: versionFile,
        CODEX_HOME: '/profile-specific-home',
      },
      [shimsDir],
    );

    expect(await service.list()).toEqual([
      { provider: 'claude', label: 'Claude Code', state: 'missing' },
      {
        provider: 'codex',
        label: 'Codex',
        state: 'installed',
        executable,
        version: 'codex-cli 1.0.0',
      },
      { provider: 'cursor', label: 'Cursor Agent', state: 'missing' },
    ]);

    const update = service.update('codex');
    await expect(service.update('claude')).rejects.toMatchObject({ code: 'tool-update-busy' });
    await expect(update).resolves.toEqual({
      previousVersion: 'codex-cli 1.0.0',
      tool: {
        provider: 'codex',
        label: 'Codex',
        state: 'installed',
        executable,
        version: 'codex-cli 2.0.0',
      },
    });
    await expect(service.update('claude')).rejects.toMatchObject({ code: 'tool-not-installed' });
  });
});
