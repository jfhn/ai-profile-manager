import type { ProviderId } from '@apm/shared';
import { describe, expect, it } from 'vitest';
import { FakeDaemon, loginCommand } from './test-support/fake-daemon';
import { WizardFlow } from './wizard.svelte';
import type { WizardOptions } from './wizard.svelte';

interface Harness {
  flow: WizardFlow;
  closed: () => number;
  toasts: string[];
  errors: string[];
  refreshes: () => number;
}

function harness(daemon: FakeDaemon, resumeProfileId?: string): Harness {
  let closed = 0;
  let refreshes = 0;
  const toasts: string[] = [];
  const errors: string[] = [];
  const options: WizardOptions = {
    api: daemon,
    refresh: async () => {
      refreshes += 1;
    },
    toast: (title) => toasts.push(title),
    toastError: (_error, context) => errors.push(context ?? 'error'),
    onclose: () => {
      closed += 1;
    },
    resumeProfileId,
  };
  return {
    flow: new WizardFlow(options),
    closed: () => closed,
    toasts,
    errors,
    refreshes: () => refreshes,
  };
}

/** Start the wizard, then walk away from it — the profile is left pending. */
async function dismissedPendingProfile(daemon: FakeDaemon, provider: ProviderId): Promise<void> {
  const first = harness(daemon);
  await first.flow.start(provider);
  first.flow.requestClose();
  expect(first.flow.discardOpen).toBe(true);
  first.flow.keepPending();
  expect(first.closed()).toBe(1);
  expect(daemon.profiles).toHaveLength(1);
  expect(daemon.profiles[0]?.status).toBe('pending');
}

describe('WizardFlow: dismiss, resume, confirm', () => {
  it('resumes a dismissed pending profile from its id alone and activates it', async () => {
    const daemon = new FakeDaemon();
    await dismissedPendingProfile(daemon, 'claude');

    // Everything below only knows what the dashboard knows after a reload: the
    // profile list. No state survives from the flow that created the profile.
    const pending = daemon.profiles.find((profile) => profile.status === 'pending');
    expect(pending).toBeDefined();
    const profileId = pending!.id;

    const { flow, closed, toasts, errors, refreshes } = harness(daemon, profileId);
    expect(await flow.resume()).toBe(true);

    // Straight to the login step, with this profile's provider and command.
    expect(flow.resumed).toBe(true);
    expect(flow.loading).toBe(false);
    expect(flow.step).toBe('login');
    expect(flow.wizardId).toBe(profileId);
    expect(flow.wizard?.profile.provider).toBe('claude');
    expect(flow.wizard?.loginCommand).toBe(loginCommand(pending!));
    expect(flow.wizard?.credentialsFound).toBe(false);

    // Still waiting: polling keeps the step where it is. The name is the
    // daemon's positional placeholder until an account turns up.
    expect(await flow.poll()).toBe(false);
    expect(flow.step).toBe('login');
    expect(flow.label).toBe('claude-1');

    // The user finishes the login in their terminal.
    daemon.credentialsFound = true;
    expect(await flow.poll()).toBe(true);
    expect(flow.identity?.account).toBe('tester@example.com');
    expect(flow.label).toBe('tester');

    flow.goToName();
    expect(flow.step).toBe('name');

    flow.label = 'work';
    await flow.confirm();

    const saved = daemon.profiles.find((profile) => profile.id === profileId);
    expect(saved?.status).toBe('active');
    expect(saved?.label).toBe('work');
    expect(daemon.deleted).toEqual([]);
    expect(refreshes()).toBe(1);
    expect(toasts).toEqual(['Profile added']);
    expect(errors).toEqual([]);
    expect(closed()).toBe(1);
  });

  it('keeps the profile pending when the resumed wizard is dismissed again', async () => {
    const daemon = new FakeDaemon();
    await dismissedPendingProfile(daemon, 'codex');
    const profileId = daemon.profiles[0]!.id;

    const { flow, closed, toasts } = harness(daemon, profileId);
    await flow.resume();
    flow.requestClose();
    expect(flow.discardOpen).toBe(true);

    flow.keepPending();
    expect(flow.discardOpen).toBe(false);
    expect(toasts).toEqual(['Kept as pending']);
    expect(closed()).toBe(1);
    expect(daemon.deleted).toEqual([]);
    expect(daemon.profiles[0]?.status).toBe('pending');

    // Still resumable afterwards.
    const again = harness(daemon, profileId);
    expect(await again.flow.resume()).toBe(true);
    expect(again.flow.step).toBe('login');
  });

  it('offers the same account-derived name a resumed wizard would', async () => {
    // `wizardState` never answers with an empty suggestion — before the login
    // completes it can only offer `claude-1`. A resumed wizard must not get
    // stuck on that placeholder once the real account shows up, or it would
    // prefill a worse name than the flow that was never interrupted.
    const uninterrupted = new FakeDaemon();
    const first = harness(uninterrupted);
    await first.flow.start('claude');
    uninterrupted.credentialsFound = true;
    await first.flow.poll();

    const dropped = new FakeDaemon();
    await dismissedPendingProfile(dropped, 'claude');
    const resumedFlow = harness(dropped, dropped.profiles[0]!.id).flow;
    await resumedFlow.resume();
    expect(resumedFlow.label).toBe('claude-1');

    dropped.credentialsFound = true;
    await resumedFlow.poll();

    expect(resumedFlow.label).toBe('tester');
    expect(resumedFlow.label).toBe(first.flow.label);
  });

  it('never overwrites a name the user typed', async () => {
    const daemon = new FakeDaemon();
    await dismissedPendingProfile(daemon, 'claude');
    const { flow } = harness(daemon, daemon.profiles[0]!.id);
    await flow.resume();

    flow.label = 'billing';
    expect(flow.labelEdited).toBe(true);

    // Later suggestions, however good, must not clobber the user's choice.
    daemon.credentialsFound = true;
    await flow.poll();
    expect(flow.label).toBe('billing');

    flow.goToName();
    await flow.confirm();
    expect(daemon.profiles[0]?.label).toBe('billing');
  });

  it('discards the profile and its managed home when asked to', async () => {
    const daemon = new FakeDaemon();
    await dismissedPendingProfile(daemon, 'claude');
    const profileId = daemon.profiles[0]!.id;

    const { flow, closed } = harness(daemon, profileId);
    await flow.resume();
    await flow.discard();

    expect(daemon.deleted).toEqual([{ id: profileId, purge: true }]);
    expect(daemon.profiles).toEqual([]);
    expect(flow.discardOpen).toBe(false);
    expect(flow.discardBusy).toBe(false);
    expect(closed()).toBe(1);
  });

  it('reports and closes when the profile is no longer resumable', async () => {
    const daemon = new FakeDaemon();
    const { flow, closed, errors } = harness(daemon, 'profile-gone');

    expect(await flow.resume()).toBe(false);
    expect(flow.loading).toBe(false);
    expect(errors).toEqual(['Could not resume the login']);
    expect(closed()).toBe(1);
  });

  it('surfaces a polling failure without leaving the login step', async () => {
    const daemon = new FakeDaemon();
    await dismissedPendingProfile(daemon, 'claude');
    const profileId = daemon.profiles[0]!.id;

    const { flow } = harness(daemon, profileId);
    await flow.resume();

    daemon.profiles = [];
    expect(await flow.poll()).toBe(false);
    expect(flow.pollError).toBe(`Unknown profile ${profileId}`);
    expect(flow.step).toBe('login');
  });
});

describe('loginCommand', () => {
  it('matches each provider adapter, including Cursor file-store env', () => {
    expect(loginCommand({ provider: 'claude', home: '/h' })).toBe('CLAUDE_CONFIG_DIR=/h claude');
    expect(loginCommand({ provider: 'codex', home: '/h' })).toBe('CODEX_HOME=/h codex login');
    expect(loginCommand({ provider: 'cursor', home: '/h' })).toBe(
      'CURSOR_CONFIG_DIR=/h AGENT_CLI_CREDENTIAL_STORE=file cursor-agent login',
    );
  });

  it('starts a Cursor wizard with that command', async () => {
    const daemon = new FakeDaemon();
    const { flow } = harness(daemon);
    await flow.start('cursor');
    const pending = daemon.profiles[0];
    expect(pending?.provider).toBe('cursor');
    expect(flow.wizard?.loginCommand).toBe(loginCommand(pending!));
    expect(flow.wizard?.loginCommand).toContain('cursor-agent login');
    expect(flow.wizard?.loginCommand).not.toContain('codex login');
  });
});
