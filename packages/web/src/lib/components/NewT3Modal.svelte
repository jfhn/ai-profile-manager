<script lang="ts">
  import type { ProviderId } from '@apm/shared';
  import { api } from '../api';
  import { app } from '../stores.svelte';
  import { toast, toastError } from '../toasts.svelte';
  import Button from './Button.svelte';
  import Modal from './Modal.svelte';

  interface Props {
    onclose: () => void;
  }

  let { onclose }: Props = $props();

  const PROVIDERS: ProviderId[] = ['claude', 'codex'];

  let label = $state('');
  let selection = $state<Record<string, string>>({ claude: '', codex: '' });
  let busy = $state(false);

  const optionsFor = (provider: ProviderId) =>
    app.launchable.filter((profile) => profile.provider === provider);

  const chosen = $derived(
    PROVIDERS.filter((provider) => (selection[provider] ?? '') !== '').length > 0,
  );

  const canSubmit = $derived(label.trim().length > 0 && chosen && !busy);

  async function create(): Promise<void> {
    if (!canSubmit) return;
    busy = true;
    try {
      const profiles: Partial<Record<ProviderId, string>> = {};
      for (const provider of PROVIDERS) {
        const id = selection[provider];
        if (id) profiles[provider] = id;
      }
      const instance = await api.createT3({ label: label.trim(), profiles });
      if (instance && typeof instance.id === 'string') {
        app.t3Instances = [...app.t3Instances, instance];
      }
      toast('Instance created', 'Start it when you need it — each one is a full T3 server.');
      onclose();
    } catch (error) {
      toastError(error, 'Could not create the instance');
    } finally {
      busy = false;
    }
  }

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    void create();
  }
</script>

<Modal
  title="New T3 instance"
  subtitle="One T3 server, bound to one profile per provider at launch."
  width={480}
  {onclose}
>
  {#if app.launchable.length === 0}
    <p class="empty">
      No active profile is available yet. Add a profile on the dashboard first — an instance always
      launches with a profile's environment.
    </p>
  {:else}
    <form onsubmit={submit} class="form">
      <div class="field">
        <label class="label" for="t3-label">Label</label>
        <input
          id="t3-label"
          class="input"
          bind:value={label}
          data-autofocus
          maxlength="64"
          autocomplete="off"
          placeholder="work"
        />
      </div>

      {#each PROVIDERS as provider (provider)}
        {@const options = optionsFor(provider)}
        <div class="field">
          <label class="label" for={`t3-${provider}`}>{app.providerLabel(provider)} profile</label>
          <select
            id={`t3-${provider}`}
            class="select"
            disabled={options.length === 0}
            bind:value={selection[provider]}
          >
            <option value="">{options.length === 0 ? 'no active profile' : 'none'}</option>
            {#each options as profile (profile.id)}
              <option value={profile.id}>{profile.label}</option>
            {/each}
          </select>
        </div>
      {/each}

      <p class="hint">
        At least one profile is required. Providers left on "none" fall back to the machine's
        default home.
      </p>
      <button type="submit" hidden aria-hidden="true"></button>
    </form>
  {/if}

  {#snippet footer()}
    <Button variant="ghost" onclick={onclose}>Cancel</Button>
    <Button variant="primary" loading={busy} disabled={!canSubmit} onclick={() => void create()}>
      Create
    </Button>
  {/snippet}
</Modal>

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .empty {
    font-size: 13px;
    color: var(--muted-fg);
  }
</style>
