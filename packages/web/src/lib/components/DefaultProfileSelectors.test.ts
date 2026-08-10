import type { Profile, ProviderInfo } from '@apm/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../stores.svelte';
import DefaultProfileSelectors from './DefaultProfileSelectors.svelte';

const mocks = vi.hoisted(() => ({
  setDefault: vi.fn(async (provider: 'claude' | 'codex', body: { profileId: string | null }) => ({
    defaultProfileIds: body.profileId === null ? {} : { [provider]: body.profileId },
  })),
}));

vi.mock('../api', () => ({
  token: 'test-token',
  eventsUrl: () => 'http://localhost/api/events',
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  api: { setDefault: mocks.setDefault },
}));

const providers: ProviderInfo[] = [
  {
    id: 'claude',
    label: 'Claude',
    capabilities: { usage: true, usageSources: ['oauth-api'], identity: true, windows: [] },
  },
  {
    id: 'codex',
    label: 'Codex',
    capabilities: { usage: true, usageSources: ['local-files'], identity: true, windows: [] },
  },
];

beforeEach(() => {
  mocks.setDefault.mockClear();
  app.providers = providers;
  app.profiles = [
    profile({ id: 'claude-work', label: 'work' }),
    profile({ id: 'claude-disabled', label: 'disabled', enabled: false }),
    profile({ id: 'claude-pending', label: 'pending', status: 'pending' }),
    profile({ id: 'codex-personal', provider: 'codex', label: 'personal' }),
  ];
  app.defaultProfileIds = { claude: 'claude-work' };
});

describe('DefaultProfileSelectors', () => {
  it('shows one selector per provider with only launchable choices', () => {
    render(DefaultProfileSelectors);

    const claude = screen.getByRole<HTMLSelectElement>('combobox', {
      name: 'Claude default profile',
    });
    const codex = screen.getByRole<HTMLSelectElement>('combobox', {
      name: 'Codex default profile',
    });
    expect(claude.value).toBe('claude-work');
    expect([...claude.options].map((option) => option.text)).toEqual(['No default', 'work']);
    expect([...codex.options].map((option) => option.text)).toEqual(['No default', 'personal']);
  });

  it('updates and clears defaults through the validated API', async () => {
    render(DefaultProfileSelectors);
    const codex = screen.getByRole<HTMLSelectElement>('combobox', {
      name: 'Codex default profile',
    });
    await fireEvent.change(codex, { target: { value: 'codex-personal' } });
    await waitFor(() =>
      expect(mocks.setDefault).toHaveBeenCalledWith('codex', { profileId: 'codex-personal' }),
    );
    expect(app.defaultProfileIds).toEqual({ codex: 'codex-personal' });

    const claude = screen.getByRole<HTMLSelectElement>('combobox', {
      name: 'Claude default profile',
    });
    await fireEvent.change(claude, { target: { value: '' } });
    await waitFor(() =>
      expect(mocks.setDefault).toHaveBeenCalledWith('claude', { profileId: null }),
    );
    expect(app.defaultProfileIds).toEqual({});
  });

  it('restores the displayed selection when an update fails', async () => {
    mocks.setDefault.mockRejectedValueOnce(new Error('offline'));
    render(DefaultProfileSelectors);
    const codex = screen.getByRole<HTMLSelectElement>('combobox', {
      name: 'Codex default profile',
    });

    await fireEvent.change(codex, { target: { value: 'codex-personal' } });

    await waitFor(() => expect(codex.value).toBe(''));
    expect(app.defaultProfileIds).toEqual({ claude: 'claude-work' });
  });
});

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: 'claude-profile',
    provider: 'claude',
    label: 'profile',
    home: '/tmp/profile',
    homeKind: 'managed',
    identity: null,
    status: 'active',
    statusReason: null,
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}
