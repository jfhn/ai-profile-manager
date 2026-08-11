/**
 * The Targets page: seeing the tailnet, approving one machine, revoking one.
 *
 * The behaviour worth pinning down is the boundary — a discovered machine is a
 * row and nothing else until a person clicks Add for that row, and revoking
 * takes it back out of the store the T3 picker reads.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../lib/stores.svelte';
import { FakeDaemon } from '../lib/test-support/fake-daemon';
import Targets from './Targets.svelte';

const mocks = vi.hoisted(() => ({ daemon: null as unknown as FakeDaemon }));

vi.mock('../lib/api', () => ({
  token: 'test-token',
  eventsUrl: () => 'http://localhost/api/events',
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  api: {
    targets: () => mocks.daemon.listTargets(),
    targetCandidates: () => mocks.daemon.listCandidates(),
    addTarget: (body: Parameters<FakeDaemon['addTarget']>[0]) => mocks.daemon.addTarget(body),
    deleteTarget: (id: string) => mocks.daemon.deleteTarget(id),
  },
}));

/** The row a name appears in, so per-row buttons are never mixed up. */
function rowFor(name: string): HTMLElement {
  const label = screen.getByText(name);
  const row = label.closest('.row');
  if (!(row instanceof HTMLElement)) throw new Error(`No row for ${name}`);
  return row;
}

beforeEach(() => {
  mocks.daemon = new FakeDaemon();
  mocks.daemon.seedTarget({ id: 'local', label: 'workstation' });
  mocks.daemon.seedCandidate({ hostname: 'dev-box' });
  mocks.daemon.seedCandidate({ hostname: 'laptop', online: false, os: 'macOS' });
  app.targets = mocks.daemon.targets;
  app.targetProfiles = {};
});

/** A target's profile list as the shared cache holds it once it was read. */
function cacheProfilesFor(targetId: string): void {
  app.targetProfiles = {
    ...app.targetProfiles,
    [targetId]: {
      state: 'ready',
      profiles: [
        { id: 'claude-remote', provider: 'claude', label: 'dev', status: 'active', enabled: true },
      ],
      reason: null,
    },
  };
}

describe('Targets page', () => {
  it('shows the tailnet without approving anything', async () => {
    render(Targets);

    expect(await screen.findByText('dev-box')).toBeDefined();
    expect(within(rowFor('dev-box')).getByText('online')).toBeDefined();
    expect(within(rowFor('laptop')).getByText('offline')).toBeDefined();
    expect(within(rowFor('laptop')).getByText('macOS')).toBeDefined();
    // Every candidate offers its own approval; nothing was approved by looking.
    expect(screen.getAllByTitle(/^Add .* as a target$/)).toHaveLength(2);
    expect(mocks.daemon.addedTargets).toEqual([]);
    expect(app.targets.map((target) => target.id)).toEqual(['local']);
    // The local machine is listed but cannot be revoked.
    expect(within(rowFor('workstation')).queryByText('Revoke')).toBeNull();
  });

  it('approves one machine and offers it to the pickers right away', async () => {
    // A target id is the user's to choose and may be reused for a different
    // machine, so an approval must not inherit a cached profile list.
    cacheProfilesFor('dev-box');
    render(Targets);
    await screen.findByText('dev-box');

    await fireEvent.click(within(rowFor('dev-box')).getByTitle('Add dev-box as a target'));

    // The address is the machine's own and is not an editable field: the only
    // way into apm is a machine the tailnet reported.
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText('dev-box.tailnet.ts.net')).toBeDefined();
    expect(dialog.getByLabelText<HTMLInputElement>('Target id').value).toBe('dev-box');
    await fireEvent.input(dialog.getByLabelText('Label'), { target: { value: 'Dev box' } });
    await fireEvent.click(dialog.getByRole('button', { name: 'Add target' }));

    await waitFor(() => expect(mocks.daemon.addedTargets).toHaveLength(1));
    expect(mocks.daemon.addedTargets[0]).toEqual({
      id: 'dev-box',
      label: 'Dev box',
      address: 'dev-box.tailnet.ts.net',
    });
    // The store the T3 target picker reads has it, without a page reload.
    await waitFor(() =>
      expect(app.targets.map((target) => target.id)).toEqual(['local', 'dev-box']),
    );
    // The next picker that opens asks the new machine itself.
    expect(app.targetProfiles['dev-box']).toBeUndefined();
    // And the candidate now reads as taken rather than offering Add again.
    await waitFor(() => expect(screen.getByText('added as dev-box')).toBeDefined());
    expect(within(rowFor('dev-box')).queryByTitle('Add dev-box as a target')).toBeNull();
    // The other machine is untouched by the approval.
    expect(within(rowFor('laptop')).getByTitle('Add laptop as a target')).toBeDefined();
  });

  it('revokes an approved machine after a confirmation', async () => {
    await mocks.daemon.addTarget({
      id: 'dev-box',
      label: 'Dev box',
      address: 'dev-box.tailnet.ts.net',
    });
    app.targets = mocks.daemon.targets;
    cacheProfilesFor('dev-box');

    render(Targets);
    await screen.findByText('added as dev-box');

    await fireEvent.click(within(rowFor('Dev box')).getByTitle('Revoke Dev box'));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText('Revoke Dev box?')).toBeDefined();
    await fireEvent.click(dialog.getByRole('button', { name: 'Revoke' }));

    await waitFor(() => expect(mocks.daemon.revokedTargets).toEqual(['dev-box']));
    await waitFor(() => expect(app.targets.map((target) => target.id)).toEqual(['local']));
    // Its profile list came from a machine apm may no longer ask, so a card
    // still bound to it reports 'unknown' instead of a stale label.
    expect(app.targetProfiles['dev-box']).toBeUndefined();
    expect(app.boundProfile('dev-box', 'claude-remote')).toEqual({ state: 'unknown', label: null });
    // It is a candidate again, offering the same explicit approval as before.
    await waitFor(() =>
      expect(within(rowFor('dev-box')).getByTitle('Add dev-box as a target')).toBeDefined(),
    );
  });

  it('says why the tailnet could not be read instead of showing an empty one', async () => {
    mocks.daemon.scanError = 'Tailscale is stopped.';
    render(Targets);

    expect(await screen.findByText('Cannot read your tailnet')).toBeDefined();
    expect(screen.getByText('Tailscale is stopped.')).toBeDefined();
    expect(screen.queryByText('dev-box')).toBeNull();

    mocks.daemon.scanError = null;
    await fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('dev-box')).toBeDefined();
  });
});
