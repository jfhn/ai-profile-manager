import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { CliToolStatus } from '@apm/shared';
import Tools from './Tools.svelte';

const installed: CliToolStatus = {
  provider: 'codex',
  label: 'Codex',
  state: 'installed',
  executable: '/opt/codex/bin/codex',
  version: 'codex-cli 1.0.0',
};

const mocks = vi.hoisted(() => ({ updateTool: vi.fn() }));

vi.mock('../lib/api', () => ({
  api: {
    tools: async () => [installed, { provider: 'claude', label: 'Claude Code', state: 'missing' }],
    updateTool: mocks.updateTool,
  },
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

describe('Tools page', () => {
  it('shows the shared executable and updates that tool once', async () => {
    mocks.updateTool.mockResolvedValue({
      previousVersion: 'codex-cli 1.0.0',
      tool: { ...installed, version: 'codex-cli 2.0.0' },
    });
    render(Tools);

    const path = await screen.findByText('/opt/codex/bin/codex');
    const row = path.closest('.row');
    if (!(row instanceof HTMLElement)) throw new Error('No Codex row');
    expect(screen.getByText('not installed')).toBeDefined();

    await fireEvent.click(within(row).getByRole('button', { name: 'Update' }));

    await waitFor(() => expect(mocks.updateTool).toHaveBeenCalledWith('codex'));
    expect(await screen.findByText('codex-cli 2.0.0')).toBeDefined();
  });
});
