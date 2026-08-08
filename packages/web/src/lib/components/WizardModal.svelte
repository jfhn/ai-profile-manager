<script lang="ts">
  import type { ProviderId, WizardStateResponse } from '@apm/shared';
  import { api } from '../api';
  import { app, refreshAll } from '../stores.svelte';
  import { toast, toastError } from '../toasts.svelte';
  import Button from './Button.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import CopyBlock from './CopyBlock.svelte';
  import Icon from './Icon.svelte';
  import Modal from './Modal.svelte';
  import Spinner from './Spinner.svelte';

  interface Props {
    onclose: () => void;
  }

  let { onclose }: Props = $props();

  type Step = 'provider' | 'login' | 'name';

  const PROVIDERS: Array<{ id: ProviderId; title: string; description: string }> = [
    {
      id: 'claude',
      title: 'Claude Code',
      description: 'Anthropic subscription account, logged in through the claude CLI.',
    },
    {
      id: 'codex',
      title: 'Codex',
      description: 'OpenAI account used by the codex CLI, with its own CODEX_HOME.',
    },
  ];

  let step = $state<Step>('provider');
  let starting = $state<ProviderId | null>(null);
  let wizard = $state<WizardStateResponse | null>(null);
  /** Kept separate from `wizard` so the polling effect never depends on its own writes. */
  let wizardId = $state<string | null>(null);
  let label = $state('');
  let confirming = $state(false);
  let discardOpen = $state(false);
  let discardBusy = $state(false);
  let pollError = $state<string | null>(null);

  const identity = $derived(wizard?.identity ?? null);

  async function start(provider: ProviderId): Promise<void> {
    if (starting) return;
    starting = provider;
    try {
      const state = await api.startWizard({ provider });
      wizard = state;
      wizardId = state.profile.id;
      label = state.suggestedLabel;
      step = 'login';
    } catch (error) {
      toastError(error, 'Could not start the login flow');
    } finally {
      starting = null;
    }
  }

  // Poll while the modal sits on the login step; the daemon watches the fresh
  // home for credentials the user creates in their own terminal.
  $effect(() => {
    const profileId = wizardId;
    if (step !== 'login' || !profileId) return;

    let cancelled = false;
    let advanceTimer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const state = await api.wizardState(profileId);
        if (cancelled) return;
        pollError = null;
        wizard = state;
        if (state.credentialsFound) {
          if (!label.trim()) label = state.suggestedLabel;
          clearInterval(timer);
          advanceTimer = setTimeout(() => {
            if (!cancelled) step = 'name';
          }, 900);
        }
      } catch (error) {
        if (!cancelled) pollError = error instanceof Error ? error.message : 'Polling failed';
      }
    };

    const timer = setInterval(() => void tick(), 2000);
    void tick();

    return () => {
      cancelled = true;
      clearInterval(timer);
      if (advanceTimer) clearTimeout(advanceTimer);
    };
  });

  async function confirm(): Promise<void> {
    const profileId = wizard?.profile.id;
    const trimmed = label.trim();
    if (!profileId || !trimmed || confirming) return;
    confirming = true;
    try {
      await api.confirmWizard(profileId, { label: trimmed });
      await refreshAll();
      toast('Profile added', `${trimmed} is ready to use.`);
      onclose();
    } catch (error) {
      toastError(error, 'Could not save the profile');
    } finally {
      confirming = false;
    }
  }

  async function discard(): Promise<void> {
    const profileId = wizard?.profile.id;
    if (!profileId) {
      onclose();
      return;
    }
    discardBusy = true;
    try {
      await api.deleteProfile(profileId, true);
      await refreshAll();
      onclose();
    } catch (error) {
      toastError(error, 'Could not discard the pending profile');
    } finally {
      discardBusy = false;
      discardOpen = false;
    }
  }

  function requestClose(): void {
    if (wizard) {
      discardOpen = true;
      return;
    }
    onclose();
  }

  function keepPending(): void {
    discardOpen = false;
    toast('Kept as pending', 'Finish the login later — the profile stays on the dashboard.');
    void refreshAll();
    onclose();
  }

  function submitName(event: SubmitEvent): void {
    event.preventDefault();
    void confirm();
  }

  const providerLabel = $derived(wizard ? app.providerLabel(wizard.profile.provider) : '');
  const stepIndex = $derived(step === 'provider' ? 0 : step === 'login' ? 1 : 2);
</script>

<Modal
  title="Add profile"
  subtitle="apm never performs the login itself — you run the provider's own command."
  width={520}
  onclose={requestClose}
>
  <ol class="steps" aria-label="Progress">
    {#each ['Provider', 'Login', 'Name'] as name, index (name)}
      <li class:done={index < stepIndex} class:current={index === stepIndex}>
        <span class="bullet">
          {#if index < stepIndex}
            <Icon name="check" size={10} strokeWidth={2} />
          {:else}
            {index + 1}
          {/if}
        </span>
        {name}
      </li>
    {/each}
  </ol>

  {#if step === 'provider'}
    <div class="providers">
      {#each PROVIDERS as provider (provider.id)}
        <button
          class="provider"
          type="button"
          disabled={starting !== null}
          onclick={() => void start(provider.id)}
        >
          <span class="provider-head">
            <span class="provider-title">{provider.title}</span>
            {#if starting === provider.id}<Spinner size={13} />{/if}
          </span>
          <span class="provider-desc">{provider.description}</span>
        </button>
      {/each}
    </div>
  {:else if step === 'login' && wizard}
    <p class="lead">Run this in a terminal, then come back:</p>
    <CopyBlock value={wizard.loginCommand} />
    <p class="home mono" title={wizard.profile.home}>{wizard.profile.home}</p>

    <div class="status" class:found={wizard.credentialsFound}>
      {#if wizard.credentialsFound}
        <span class="check"><Icon name="check" size={13} /></span>
        <div>
          <p class="status-title">Login detected</p>
          <p class="status-sub">
            {identity?.account ?? 'account unknown'}{identity?.plan ? ` · ${identity.plan}` : ''}
          </p>
        </div>
      {:else}
        <Spinner size={14} />
        <div>
          <p class="status-title">Waiting for login…</p>
          <p class="status-sub">
            {pollError ?? `A fresh ${providerLabel} home is ready; apm checks it every 2 seconds.`}
          </p>
        </div>
      {/if}
    </div>
  {:else if step === 'name' && wizard}
    <div class="detected">
      <span class="check"><Icon name="check" size={13} /></span>
      <div>
        <p class="status-title">{identity?.account ?? 'Credentials found'}</p>
        <p class="status-sub">
          {providerLabel}{identity?.plan ? ` · ${identity.plan}` : ''}{identity?.organization
            ? ` · ${identity.organization}`
            : ''}
        </p>
      </div>
    </div>

    <form onsubmit={submitName}>
      <div class="field">
        <label class="label" for="wizard-label">Profile name</label>
        <input
          id="wizard-label"
          class="input"
          bind:value={label}
          data-autofocus
          maxlength="64"
          autocomplete="off"
        />
        <p class="hint">Unique per provider — "work" can exist for both Claude and Codex.</p>
      </div>
      <button type="submit" hidden aria-hidden="true"></button>
    </form>
  {/if}

  {#snippet footer()}
    {#if step === 'provider'}
      <Button variant="ghost" onclick={requestClose}>Cancel</Button>
    {:else if step === 'login'}
      <Button variant="ghost" onclick={requestClose}>Cancel</Button>
      <Button
        disabled={!wizard?.credentialsFound}
        variant="primary"
        onclick={() => (step = 'name')}
      >
        Continue
      </Button>
    {:else}
      <Button variant="ghost" onclick={requestClose}>Cancel</Button>
      <Button
        variant="primary"
        loading={confirming}
        disabled={label.trim().length === 0}
        onclick={() => void confirm()}
      >
        Confirm
      </Button>
    {/if}
  {/snippet}
</Modal>

{#if discardOpen}
  <ConfirmDialog
    title="Leave the wizard?"
    message="A pending profile and a fresh home were already created for this login."
    confirmLabel="Discard"
    cancelLabel="Keep pending"
    busy={discardBusy}
    onconfirm={() => void discard()}
    oncancel={keepPending}
  />
{/if}

<style>
  .steps {
    display: flex;
    align-items: center;
    gap: 16px;
    margin: 0 0 18px;
    padding: 0;
    list-style: none;
    font-size: 12px;
    color: var(--muted-fg);
  }

  .steps li {
    display: flex;
    align-items: center;
    gap: 7px;
  }

  .steps li.current {
    color: var(--fg);
  }

  .bullet {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border-radius: 999px;
    border: 1px solid var(--input);
    font-size: 10px;
  }

  .steps li.current .bullet {
    border-color: transparent;
    background: var(--primary);
    color: var(--primary-fg);
  }

  .steps li.done .bullet {
    border-color: transparent;
    background: color-mix(in oklab, var(--success) 22%, transparent);
    color: color-mix(in oklab, var(--success) 80%, var(--tint-contrast));
  }

  .providers {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }

  .provider {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 14px;
    text-align: left;
    background: var(--fill-2);
    border: 1px solid var(--input);
    border-radius: var(--radius);
    transition:
      border-color 120ms ease,
      background 120ms ease;
  }

  .provider:hover:not(:disabled) {
    background: var(--hover);
    border-color: color-mix(in oklab, var(--primary) 45%, var(--input));
  }

  .provider-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .provider-title {
    font-size: 13px;
    font-weight: 600;
  }

  .provider-desc {
    font-size: 12px;
    color: var(--muted-fg);
  }

  .lead {
    margin-bottom: 10px;
    font-size: 13px;
  }

  .home {
    margin-top: 8px;
    color: var(--muted-fg);
    overflow-wrap: anywhere;
  }

  .status,
  .detected {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 16px;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--fill-2);
    color: var(--muted-fg);
  }

  .status.found,
  .detected {
    border-color: color-mix(in oklab, var(--success) 26%, transparent);
    background: color-mix(in oklab, var(--success) 7%, transparent);
  }

  .detected {
    margin-top: 0;
    margin-bottom: 18px;
  }

  .check {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    flex: none;
    border-radius: 999px;
    background: color-mix(in oklab, var(--success) 20%, transparent);
    color: color-mix(in oklab, var(--success) 85%, var(--tint-contrast));
  }

  .status-title {
    font-size: 13px;
    color: var(--fg);
  }

  .status-sub {
    font-size: 12px;
    color: var(--muted-fg);
  }
</style>
