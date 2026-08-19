<script lang="ts">
  import type { ProviderId } from '@apm/shared';
  import { api } from '../api';
  import { app, refreshAll } from '../stores.svelte';
  import { toast, toastError } from '../toasts.svelte';
  import { WizardFlow } from '../wizard.svelte';
  import Button from './Button.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import CopyBlock from './CopyBlock.svelte';
  import Icon from './Icon.svelte';
  import Modal from './Modal.svelte';
  import Spinner from './Spinner.svelte';

  interface Props {
    onclose: () => void;
    /** Reopen the login step for this already-pending profile instead of starting fresh. */
    resumeProfileId?: string;
  }

  let { onclose, resumeProfileId }: Props = $props();

  const PROVIDER_COPY: Record<ProviderId, { title: string; description: string }> = {
    claude: {
      title: 'Claude Code',
      description: 'Anthropic subscription account, logged in through the claude CLI.',
    },
    codex: {
      title: 'Codex',
      description: 'OpenAI account used by the codex CLI, with its own CODEX_HOME.',
    },
    cursor: {
      title: 'Cursor',
      description:
        'Logged in through cursor-agent, with CURSOR_CONFIG_DIR and a file credential store.',
    },
  };

  const FALLBACK_PROVIDER_IDS: ProviderId[] = ['claude', 'codex', 'cursor'];

  const providers = $derived(
    app.providers.length > 0
      ? app.providers.map((info) => ({ id: info.id, ...PROVIDER_COPY[info.id] }))
      : FALLBACK_PROVIDER_IDS.map((id) => ({ id, ...PROVIDER_COPY[id] })),
  );

  const flow = new WizardFlow({
    api,
    refresh: refreshAll,
    toast,
    toastError,
    // Props go in through closures so the flow reads them lazily instead of
    // capturing whatever they happened to be at init.
    onclose: () => onclose(),
    get resumeProfileId() {
      return resumeProfileId;
    },
  });

  // No-op unless the card opened this modal for a pending profile. Kicked off
  // during init so the login step is already the one being loaded on first paint.
  void flow.resume();

  // Poll while the modal sits on the login step; the daemon watches the fresh
  // home for credentials the user creates in their own terminal.
  $effect(() => {
    if (flow.step !== 'login' || !flow.wizardId) return;

    let cancelled = false;
    let advanceTimer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      const found = await flow.poll();
      if (cancelled || !found) return;
      clearInterval(timer);
      advanceTimer = setTimeout(() => {
        if (!cancelled) flow.goToName();
      }, 900);
    };

    const timer = setInterval(() => void tick(), 2000);
    void tick();

    return () => {
      cancelled = true;
      clearInterval(timer);
      if (advanceTimer) clearTimeout(advanceTimer);
    };
  });

  function submitName(event: SubmitEvent): void {
    event.preventDefault();
    void flow.confirm();
  }

  const wizard = $derived(flow.wizard);
  const identity = $derived(flow.identity);
  const providerLabel = $derived(wizard ? app.providerLabel(wizard.profile.provider) : '');
  const stepIndex = $derived(flow.step === 'provider' ? 0 : flow.step === 'login' ? 1 : 2);
</script>

<Modal
  title={flow.resumed ? 'Resume login' : 'Add profile'}
  subtitle="apm never performs the login itself — you run the provider's own command."
  width={520}
  onclose={() => flow.requestClose()}
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

  {#if flow.loading}
    <div class="status">
      <Spinner size={14} />
      <div>
        <p class="status-title">Loading the login details…</p>
        <p class="status-sub">Fetching the command for this pending profile.</p>
      </div>
    </div>
  {:else if flow.step === 'provider'}
    <div class="providers">
      {#each providers as provider (provider.id)}
        <button
          class="provider"
          type="button"
          disabled={flow.starting !== null}
          onclick={() => void flow.start(provider.id)}
        >
          <span class="provider-head">
            <span class="provider-title">{provider.title}</span>
            {#if flow.starting === provider.id}<Spinner size={13} />{/if}
          </span>
          <span class="provider-desc">{provider.description}</span>
        </button>
      {/each}
    </div>
  {:else if flow.step === 'login' && wizard}
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
            {flow.pollError ??
              `A fresh ${providerLabel} home is ready; apm checks it every 2 seconds.`}
          </p>
        </div>
      {/if}
    </div>
  {:else if flow.step === 'name' && wizard}
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
          bind:value={flow.label}
          data-autofocus
          maxlength="64"
          autocomplete="off"
        />
        <p class="hint">Unique per provider — "work" can exist for Claude, Codex, and Cursor.</p>
      </div>
      <button type="submit" hidden aria-hidden="true"></button>
    </form>
  {/if}

  {#snippet footer()}
    {#if flow.step === 'provider'}
      <Button variant="ghost" onclick={() => flow.requestClose()}>Cancel</Button>
    {:else if flow.step === 'login'}
      <Button variant="ghost" onclick={() => flow.requestClose()}>Cancel</Button>
      <Button
        disabled={!wizard?.credentialsFound}
        variant="primary"
        onclick={() => flow.goToName()}
      >
        Continue
      </Button>
    {:else}
      <Button variant="ghost" onclick={() => flow.requestClose()}>Cancel</Button>
      <Button
        variant="primary"
        loading={flow.confirming}
        disabled={flow.label.trim().length === 0}
        onclick={() => void flow.confirm()}
      >
        Confirm
      </Button>
    {/if}
  {/snippet}
</Modal>

{#if flow.discardOpen}
  <ConfirmDialog
    title="Leave the wizard?"
    message={flow.resumed
      ? 'Keeping it pending leaves the profile on the dashboard, ready to resume. Discarding removes the profile and its managed home.'
      : 'A pending profile and a fresh home were already created for this login.'}
    confirmLabel="Discard"
    cancelLabel="Keep pending"
    busy={flow.discardBusy}
    onconfirm={() => void flow.discard()}
    oncancel={() => flow.keepPending()}
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
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
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
