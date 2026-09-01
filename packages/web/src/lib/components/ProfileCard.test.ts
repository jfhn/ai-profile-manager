import type { Profile, ProfileCopyRequest, ProfileCopyResponse, UsageSnapshot } from '@apm/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { profileView } from '../runway';
import { app } from '../stores.svelte';
import { FakeDaemon, loginCommand } from '../test-support/fake-daemon';
import ProfileCard from './ProfileCard.svelte';

/**
 * Hoisted so the `../api` factory below can reach it. The daemon itself is
 * rebuilt per test in `beforeEach`.
 */
const mocks = vi.hoisted(() => ({
  daemon: null as unknown as FakeDaemon,
  refreshedProfiles: [] as string[],
  setDefault: null as unknown as ReturnType<typeof vi.fn>,
  copyProfile: null as unknown as ReturnType<typeof vi.fn>,
}));

// The card pulls in the real api module transitively (via stores and toasts),
// which would resolve a daemon token and make network calls. Everything the
// wizard path touches is routed to the fake instead.
vi.mock('../api', () => ({
  token: 'test-token',
  eventsUrl: () => 'http://localhost/api/events',
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  api: {
    startWizard: (body: Parameters<FakeDaemon['startWizard']>[0]) => mocks.daemon.startWizard(body),
    wizardState: (id: string) => mocks.daemon.wizardState(id),
    confirmWizard: (id: string, body: Parameters<FakeDaemon['confirmWizard']>[1]) =>
      mocks.daemon.confirmWizard(id, body),
    deleteProfile: (id: string, purge?: boolean) => mocks.daemon.deleteProfile(id, purge),
    refreshProfile: async (id: string) => {
      mocks.refreshedProfiles.push(id);
    },
    setDefault: (provider: string, body: { profileId: string | null }) =>
      mocks.setDefault(provider, body),
    copyProfile: (id: string, body: ProfileCopyRequest) => mocks.copyProfile(id, body),
    overview: async () => ({
      providers: [],
      profiles: mocks.daemon.profiles,
      defaultProfileIds: {},
      usage: {},
      sessions: [],
    }),
    discovery: async () => ({ candidates: [] }),
  },
}));

/** A second pending profile that is never rendered — see `decoy` below. */
let decoy: Profile;
let pending: Profile;

beforeEach(() => {
  // Real time still advances, so testing-library's polling helpers keep
  // working while we jump the wizard's 2s credential poll by hand.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mocks.daemon = new FakeDaemon();
  mocks.refreshedProfiles = [];
  mocks.setDefault = vi.fn(async (provider: string, body: { profileId: string | null }) => ({
    defaultProfileIds: { [provider]: body.profileId },
  }));
  mocks.copyProfile = vi.fn(
    async (profileId: string, body: ProfileCopyRequest): Promise<ProfileCopyResponse> => {
      const profile = mocks.daemon.profile(profileId);
      if (!profile) throw new Error('Profile not found');
      return {
        profile: { ...profile, sync: { id: 'sync-1', role: 'owner' } },
        results: body.targetIds.map((targetId) => ({
          targetId,
          status: 'copied' as const,
          profile: {
            id: `${targetId}-profile`,
            provider: profile.provider,
            label: profile.label,
            status: 'active' as const,
            enabled: true,
          },
        })),
      };
    },
  );
  app.usage = {};
  app.defaultProfileIds = {};
  app.targets = [];
  // Seeded first so the profile under test is neither the only pending one nor
  // the first id the fake hands out. A card that resumed a hard-coded or
  // otherwise wrong profile would now talk to the decoy and fail.
  decoy = mocks.daemon.seedPending('claude');
  pending = mocks.daemon.seedPending('claude');
  app.profiles = mocks.daemon.profiles;
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Built through the real factory rather than hand-rolled, so the card under
 * test keeps seeing exactly the view the dashboard builds for it.
 */
function renderCard(profile: Profile) {
  return render(ProfileCard, { view: profileView(profile, undefined, Date.now()) });
}

describe('ProfileCard: resuming a pending profile', () => {
  it('walks a dismissed pending profile from the card through to active', async () => {
    renderCard(pending);

    // The dead end the issue describes, now with a way out of it.
    expect(screen.getByText('Waiting for the login to finish in your terminal.')).toBeDefined();
    await fireEvent.click(screen.getByRole('button', { name: 'Resume login' }));

    // The wizard asked the daemon about this profile and nothing else, and it
    // opened on the login step rather than the provider picker.
    await waitFor(() => expect(mocks.daemon.wizardStateCalls).toContain(pending.id));
    expect([...new Set(mocks.daemon.wizardStateCalls)]).toEqual([pending.id]);
    expect(mocks.daemon.wizardStateCalls).not.toContain(decoy.id);
    expect(screen.getByRole('dialog', { name: 'Resume login' })).toBeDefined();
    // The provider picker is skipped — the profile already has a provider.
    expect(screen.queryByText('Claude Code')).toBeNull();

    // The command is this profile's managed home, straight from the daemon.
    await screen.findByText(loginCommand(pending));

    // The user completes the login in their terminal; the next poll notices.
    mocks.daemon.credentialsFound = true;
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(900);

    const input = await screen.findByLabelText<HTMLInputElement>('Profile name');
    // Prefilled from the account, not the `claude-1` placeholder the daemon
    // hands out while it is still waiting for credentials.
    expect(input.value).toBe('tester');

    await fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(mocks.daemon.profile(pending.id)?.status).toBe('active'));
    expect(mocks.daemon.profile(pending.id)?.label).toBe('tester');
    expect(mocks.daemon.deleted).toEqual([]);
  });

  it('offers the same resume action from the card menu', async () => {
    renderCard(pending);

    await fireEvent.click(screen.getByRole('button', { name: `Actions for ${pending.label}` }));
    const items = screen.getAllByRole('menuitem').map((item) => item.textContent?.trim());
    expect(items[0]).toBe('Resume login');

    await fireEvent.click(screen.getByRole('menuitem', { name: 'Resume login' }));
    await screen.findByText(loginCommand(pending));
    expect([...new Set(mocks.daemon.wizardStateCalls)]).toEqual([pending.id]);
    expect(mocks.daemon.wizardStateCalls).not.toContain(decoy.id);
  });

  it('keeps the resume action off an active profile', () => {
    const active: Profile = { ...pending, status: 'active', label: 'work' };
    renderCard(active);

    expect(screen.queryByRole('button', { name: 'Resume login' })).toBeNull();
    expect(screen.queryByText('Waiting for the login to finish in your terminal.')).toBeNull();
  });

  it('leaves the profile pending when the resumed wizard is closed again', async () => {
    renderCard(pending);
    await fireEvent.click(screen.getByRole('button', { name: 'Resume login' }));
    await screen.findByText(loginCommand(pending));

    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await fireEvent.click(await screen.findByRole('button', { name: 'Keep pending' }));

    await waitFor(() => expect(screen.queryByText(loginCommand(pending))).toBeNull());
    expect(mocks.daemon.deleted).toEqual([]);
    expect(mocks.daemon.profile(pending.id)?.status).toBe('pending');
  });
});

describe('ProfileCard: the default star', () => {
  it('renders the filled, inert "Default" star on the default profile', async () => {
    const active: Profile = { ...pending, status: 'active', label: 'work' };
    app.defaultProfileIds = { claude: active.id };
    renderCard(active);

    const star = screen.getByRole('button', { name: 'Default' });
    expect(star.getAttribute('aria-pressed')).toBe('true');

    // Clicking the active star is a no-op: there is no path to "no default".
    await fireEvent.click(star);
    expect(mocks.setDefault).not.toHaveBeenCalled();
    expect(app.defaultProfileIds).toEqual({ claude: active.id });
  });

  it('moves the default here when a "Set default" star is clicked', async () => {
    const active: Profile = { ...pending, status: 'active', label: 'work' };
    app.defaultProfileIds = { claude: 'some-other-profile' };
    renderCard(active);

    const star = screen.getByRole('button', { name: 'Set default' });
    expect(star.getAttribute('aria-pressed')).toBe('false');

    await fireEvent.click(star);
    await waitFor(() =>
      expect(mocks.setDefault).toHaveBeenCalledWith('claude', { profileId: active.id }),
    );
    expect(app.defaultProfileIds).toEqual({ claude: active.id });
    expect(screen.getByRole('button', { name: 'Default' })).toBeDefined();
  });

  it('keeps the previous default and surfaces a toast when the daemon refuses', async () => {
    mocks.setDefault.mockRejectedValueOnce(new Error('offline'));
    const active: Profile = { ...pending, status: 'active', label: 'work' };
    app.defaultProfileIds = { claude: 'some-other-profile' };
    renderCard(active);

    await fireEvent.click(screen.getByRole('button', { name: 'Set default' }));

    await waitFor(() => expect(mocks.setDefault).toHaveBeenCalled());
    expect(app.defaultProfileIds).toEqual({ claude: 'some-other-profile' });
    expect(screen.getByRole('button', { name: 'Set default' })).toBeDefined();
  });

  it('carries no star on profiles the daemon would reject as default', () => {
    renderCard(pending);
    expect(screen.queryByRole('button', { name: 'Set default' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Default' })).toBeNull();
  });
});

describe('ProfileCard: copying credentials to machines', () => {
  it('copies to explicit compatible selections and retries only a failed machine', async () => {
    const active: Profile = { ...pending, status: 'active', label: 'work' };
    mocks.daemon.profiles = mocks.daemon.profiles.map((profile) =>
      profile.id === active.id ? active : profile,
    );
    app.profiles = mocks.daemon.profiles;

    mocks.daemon.seedTarget({ id: 'local', label: 'This machine' });
    mocks.daemon.seedTarget({
      id: 'dev-box',
      label: 'Development box',
      capabilities: ['exec', 'pty', 'signal', 'profiles', 'sync'],
      identity: {
        hostname: 'dev-box',
        address: 'dev-box.tailnet.ts.net',
        fingerprint: null,
      },
    });
    mocks.daemon.seedTarget({
      id: 'laptop',
      label: 'Laptop',
      capabilities: ['exec', 'pty', 'signal', 'profiles', 'sync'],
      status: 'offline',
    });
    mocks.daemon.seedTarget({ id: 'legacy', label: 'Legacy machine' });
    app.targets = mocks.daemon.targets;

    mocks.copyProfile.mockResolvedValueOnce({
      profile: { ...active, sync: { id: 'sync-1', role: 'owner' } },
      results: [
        {
          targetId: 'dev-box',
          status: 'copied',
          profile: {
            id: 'remote-work',
            provider: 'claude',
            label: 'work',
            status: 'active',
            enabled: true,
          },
        },
        { targetId: 'laptop', status: 'failed', errorCode: 'unreachable' },
      ],
    });

    renderCard(active);
    await fireEvent.click(screen.getByRole('button', { name: 'Actions for work' }));
    await fireEvent.click(screen.getByRole('menuitem', { name: 'Copy to machines' }));

    expect(screen.getByRole('dialog', { name: 'Copy work' })).toBeDefined();
    expect(screen.queryByText('Legacy machine')).toBeNull();
    expect(screen.queryByText('This machine')).toBeNull();

    const devBox = screen.getByRole<HTMLInputElement>('checkbox', { name: /Development box/ });
    const laptop = screen.getByRole<HTMLInputElement>('checkbox', { name: /Laptop/ });
    const copyNone = screen.getByRole('button', { name: 'Copy profile' });
    expect(devBox.checked).toBe(false);
    expect(laptop.checked).toBe(false);
    expect(copyNone.hasAttribute('disabled')).toBe(true);

    await fireEvent.click(devBox);
    await fireEvent.click(laptop);
    await fireEvent.click(screen.getByRole('button', { name: 'Copy to 2 machines' }));

    await waitFor(() =>
      expect(mocks.copyProfile).toHaveBeenNthCalledWith(1, active.id, {
        targetIds: ['dev-box', 'laptop'],
      }),
    );
    expect(await screen.findByText('Copied as work')).toBeDefined();
    expect(screen.getByText('Machine unavailable')).toBeDefined();
    expect(devBox.checked).toBe(false);
    expect(laptop.checked).toBe(true);

    await fireEvent.click(screen.getByRole('button', { name: 'Retry failed' }));
    await waitFor(() =>
      expect(mocks.copyProfile).toHaveBeenNthCalledWith(2, active.id, { targetIds: ['laptop'] }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Copy work' })).toBeNull());
  });

  it('links to target setup when no compatible machine is registered', async () => {
    const active: Profile = { ...pending, status: 'active', label: 'work' };
    renderCard(active);

    await fireEvent.click(screen.getByRole('button', { name: 'Actions for work' }));
    await fireEvent.click(screen.getByRole('menuitem', { name: 'Copy to machines' }));

    expect(screen.getByText('No compatible targets')).toBeDefined();
    expect(screen.getByRole('link', { name: 'Manage targets' }).getAttribute('href')).toBe(
      '#/targets',
    );
  });

  it('does not offer credential copying for Cursor profiles', async () => {
    const cursor: Profile = {
      ...pending,
      provider: 'cursor',
      status: 'active',
      label: 'cursor-work',
    };
    renderCard(cursor);

    await fireEvent.click(screen.getByRole('button', { name: 'Actions for cursor-work' }));
    expect(screen.queryByRole('menuitem', { name: 'Copy to machines' })).toBeNull();
  });
});

describe('ProfileCard: remaining percents', () => {
  it('shows up to two decimal places and keeps whole percents whole', () => {
    const active: Profile = { ...pending, status: 'active', label: 'work', provider: 'cursor' };
    const snapshot: UsageSnapshot = {
      profileId: active.id,
      windows: [
        {
          id: 'cursor_models',
          label: 'Cursor Models',
          usedPercent: 0.4555,
          remainingPercent: 99.5445,
          resetAt: '2026-09-01T00:00:00.000Z',
        },
        {
          id: 'other_models',
          label: 'Other Models',
          usedPercent: 0,
          remainingPercent: 100,
          resetAt: '2026-09-01T00:00:00.000Z',
        },
      ],
      fetchedAt: '2026-01-10T12:00:00.000Z',
      source: 'Cursor usage endpoint cache',
      cacheStatus: 'live',
      dataUpdatedAt: null,
      stale: false,
      staleReason: null,
      failureKind: null,
      error: null,
      planType: 'ultra',
      retryAfterSeconds: null,
    };
    render(ProfileCard, { view: profileView(active, snapshot, Date.now()) });
    expect(screen.getByText('99.54% left')).toBeDefined();
    expect(screen.getByText('100% left')).toBeDefined();
  });
});

describe('ProfileCard: refreshing usage', () => {
  it('completes a refresh from the daemon 204 response and waits for the SSE update', async () => {
    const active: Profile = { ...pending, status: 'active', label: 'work' };
    renderCard(active);

    const refresh = screen.getByRole('button', { name: 'Refresh usage for work' });
    await fireEvent.click(refresh);

    await waitFor(() => expect(mocks.refreshedProfiles).toEqual([active.id]));
    expect(app.usage[active.id]).toBeUndefined();
    await waitFor(() => expect(refresh.hasAttribute('disabled')).toBe(false));
  });
});
