import type { Profile } from '@apm/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { profileView } from '../runway';
import { FakeDaemon, loginCommand } from '../test-support/fake-daemon';
import ProfileCard from './ProfileCard.svelte';

/**
 * Hoisted so the `../api` factory below can reach it. The daemon itself is
 * rebuilt per test in `beforeEach`.
 */
const mocks = vi.hoisted(() => ({ daemon: null as unknown as FakeDaemon }));

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
    overview: async () => ({
      providers: [],
      profiles: mocks.daemon.profiles,
      usage: {},
      sessions: [],
      t3Instances: [],
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
  // Seeded first so the profile under test is neither the only pending one nor
  // the first id the fake hands out. A card that resumed a hard-coded or
  // otherwise wrong profile would now talk to the decoy and fail.
  decoy = mocks.daemon.seedPending('claude');
  pending = mocks.daemon.seedPending('claude');
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
