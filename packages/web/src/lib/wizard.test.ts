import type {
  ConfirmWizardRequest,
  Profile,
  ProviderId,
  StartWizardRequest,
  WizardStateResponse,
} from '@apm/shared';
import { describe, expect, it } from 'vitest';
import { WizardFlow } from './wizard.svelte';
import type { WizardApi, WizardOptions } from './wizard.svelte';

/**
 * A stand-in for the daemon: it owns the profile list, so a second WizardFlow
 * built from nothing but a profile id behaves exactly like the dashboard after
 * a page reload.
 */
class FakeDaemon implements WizardApi {
  profiles: Profile[] = [];
  /** Flipped when the user finishes the provider login in their terminal. */
  credentialsFound = false;
  deleted: Array<{ id: string; purge: boolean }> = [];
  private counter = 0;

  async startWizard({ provider }: StartWizardRequest): Promise<WizardStateResponse> {
    const id = `profile-${++this.counter}`;
    const profile: Profile = {
      id,
      provider,
      label: '',
      home: `/home/tester/.apm/homes/${provider}/${id}`,
      homeKind: 'managed',
      identity: null,
      status: 'pending',
      statusReason: null,
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    this.profiles = [...this.profiles, profile];
    return this.state(profile);
  }

  async wizardState(profileId: string): Promise<WizardStateResponse> {
    const profile = this.find(profileId);
    if (profile.status !== 'pending') throw new Error('Profile is not pending login');
    return this.state(profile);
  }

  async confirmWizard(profileId: string, { label }: ConfirmWizardRequest): Promise<Profile> {
    const profile = this.find(profileId);
    if (profile.status !== 'pending') throw new Error('Profile is not pending login');
    if (!this.credentialsFound) throw new Error('No credentials found');
    const updated: Profile = { ...profile, label, status: 'active' };
    this.profiles = this.profiles.map((it) => (it.id === profileId ? updated : it));
    return updated;
  }

  async deleteProfile(profileId: string, purge = false): Promise<void> {
    this.deleted.push({ id: profileId, purge });
    this.profiles = this.profiles.filter((it) => it.id !== profileId);
  }

  private find(profileId: string): Profile {
    const profile = this.profiles.find((it) => it.id === profileId);
    if (!profile) throw new Error(`Unknown profile ${profileId}`);
    return profile;
  }

  private state(profile: Profile): WizardStateResponse {
    return {
      profile,
      loginCommand: loginCommand(profile),
      credentialsFound: this.credentialsFound,
      identity: this.credentialsFound
        ? { account: 'tester@example.com', organization: null, plan: 'max' }
        : null,
      // The daemon derives the suggestion from the identity, so there is none
      // until the credentials show up.
      suggestedLabel: this.credentialsFound ? 'tester' : '',
    };
  }
}

function loginCommand(profile: Profile): string {
  return profile.provider === 'claude'
    ? `CLAUDE_CONFIG_DIR=${profile.home} claude /login`
    : `CODEX_HOME=${profile.home} codex login`;
}

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
    expect(flow.wizard?.loginCommand).toBe(`CLAUDE_CONFIG_DIR=${pending!.home} claude /login`);
    expect(flow.wizard?.credentialsFound).toBe(false);

    // Still waiting: polling keeps the step where it is.
    expect(await flow.poll()).toBe(false);
    expect(flow.step).toBe('login');
    expect(flow.label).toBe('');

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
