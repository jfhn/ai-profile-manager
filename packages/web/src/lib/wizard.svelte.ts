import type {
  ConfirmWizardRequest,
  Profile,
  ProviderId,
  StartWizardRequest,
  WizardStateResponse,
} from '@apm/shared';

export type WizardStep = 'provider' | 'login' | 'name';

/**
 * The slice of the api client the wizard needs. Declared structurally (and
 * without importing the real client) so the flow can be driven by a fake in
 * tests — `./api` resolves the daemon token at import time and needs a browser.
 */
export interface WizardApi {
  startWizard(body: StartWizardRequest): Promise<WizardStateResponse>;
  wizardState(profileId: string): Promise<WizardStateResponse>;
  confirmWizard(profileId: string, body: ConfirmWizardRequest): Promise<Profile>;
  deleteProfile(profileId: string, purge?: boolean): Promise<void>;
}

export interface WizardOptions {
  api: WizardApi;
  /** Refetch the overview so the dashboard reflects the wizard's result. */
  refresh: () => Promise<void>;
  toast: (title: string, description?: string) => void;
  toastError: (error: unknown, context?: string) => void;
  onclose: () => void;
  /** Reopen the login step for this already-pending profile instead of starting fresh. */
  readonly resumeProfileId?: string | undefined;
}

/**
 * The "add profile" state machine, kept out of the component so both entry
 * points — starting fresh and resuming a profile that is still pending — share
 * one implementation, and so the whole path is testable without a DOM.
 */
export class WizardFlow {
  private readonly options: WizardOptions;
  /** Plain field on purpose: guarding the one-shot resume must not be reactive. */
  private resumeStarted = false;

  step = $state<WizardStep>('provider');
  starting = $state<ProviderId | null>(null);
  wizard = $state<WizardStateResponse | null>(null);
  /** Kept separate from `wizard` so the polling effect never depends on its own writes. */
  wizardId = $state<string | null>(null);
  label = $state('');
  /** Resuming an already-pending profile rather than creating a new one. */
  resumed = $state(false);
  /** The initial wizard-state fetch of a resume is still in flight. */
  loading = $state(false);
  confirming = $state(false);
  discardOpen = $state(false);
  discardBusy = $state(false);
  pollError = $state<string | null>(null);

  readonly identity = $derived(this.wizard?.identity ?? null);

  constructor(options: WizardOptions) {
    this.options = options;
  }

  async start(provider: ProviderId): Promise<void> {
    if (this.starting) return;
    this.starting = provider;
    try {
      const state = await this.options.api.startWizard({ provider });
      this.adopt(state);
    } catch (error) {
      this.options.toastError(error, 'Could not start the login flow');
    } finally {
      this.starting = null;
    }
  }

  /**
   * Reopen the login step for the profile that is already pending. Its id is
   * the only input, so this survives a page reload — nothing is carried over
   * from the session that created the profile.
   */
  async resume(): Promise<boolean> {
    const profileId = this.options.resumeProfileId;
    if (!profileId || this.resumeStarted) return false;
    this.resumeStarted = true;
    this.resumed = true;
    this.loading = true;
    try {
      this.adopt(await this.options.api.wizardState(profileId));
      return true;
    } catch (error) {
      this.options.toastError(error, 'Could not resume the login');
      this.options.onclose();
      return false;
    } finally {
      this.loading = false;
    }
  }

  /** Ask the daemon once whether the credentials have shown up yet. */
  async poll(): Promise<boolean> {
    const profileId = this.wizardId;
    if (!profileId) return false;
    try {
      const state = await this.options.api.wizardState(profileId);
      this.pollError = null;
      this.wizard = state;
      if (!state.credentialsFound) return false;
      if (!this.label.trim()) this.label = state.suggestedLabel;
      return true;
    } catch (error) {
      this.pollError = error instanceof Error ? error.message : 'Polling failed';
      return false;
    }
  }

  goToName(): void {
    this.step = 'name';
  }

  async confirm(): Promise<void> {
    const profileId = this.wizard?.profile.id;
    const trimmed = this.label.trim();
    if (!profileId || !trimmed || this.confirming) return;
    this.confirming = true;
    try {
      await this.options.api.confirmWizard(profileId, { label: trimmed });
      await this.options.refresh();
      this.options.toast('Profile added', `${trimmed} is ready to use.`);
      this.options.onclose();
    } catch (error) {
      this.options.toastError(error, 'Could not save the profile');
    } finally {
      this.confirming = false;
    }
  }

  async discard(): Promise<void> {
    const profileId = this.wizard?.profile.id;
    if (!profileId) {
      this.options.onclose();
      return;
    }
    this.discardBusy = true;
    try {
      await this.options.api.deleteProfile(profileId, true);
      await this.options.refresh();
      this.options.onclose();
    } catch (error) {
      this.options.toastError(error, 'Could not discard the pending profile');
    } finally {
      this.discardBusy = false;
      this.discardOpen = false;
    }
  }

  /** Closing mid-flow always asks first — a pending profile is already on disk. */
  requestClose(): void {
    if (this.wizard) {
      this.discardOpen = true;
      return;
    }
    this.options.onclose();
  }

  /** "Keep pending" just leaves the modal; the profile stays resumable. */
  keepPending(): void {
    this.discardOpen = false;
    this.options.toast(
      'Kept as pending',
      'Finish the login later — the profile stays on the dashboard.',
    );
    void this.options.refresh();
    this.options.onclose();
  }

  private adopt(state: WizardStateResponse): void {
    this.wizard = state;
    this.wizardId = state.profile.id;
    if (!this.label.trim()) this.label = state.suggestedLabel;
    this.step = 'login';
  }
}
