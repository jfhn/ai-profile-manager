<script module lang="ts">
  import type { DiscoveryCandidate } from '@apm/shared';

  /** Prefill the label from the detected identity, e.g. "jan@acme.io" -> "jan". */
  export function suggestLabel(candidate: DiscoveryCandidate): string {
    const account = candidate.identity?.account;
    if (account) {
      const local = account.split('@')[0]?.trim();
      if (local) return local.toLowerCase();
    }
    if (candidate.isDefault) return 'default';
    const base = candidate.home.split('/').filter(Boolean).pop() ?? 'profile';
    return base.replace(/^\./, '') || 'profile';
  }
</script>

<script lang="ts">
  import { untrack } from 'svelte';
  import { api } from '../api';
  import { refreshAll } from '../stores.svelte';
  import { toast, toastError } from '../toasts.svelte';
  import Button from './Button.svelte';
  import Modal from './Modal.svelte';
  import ProviderBadge from './ProviderBadge.svelte';

  interface Props {
    candidate: DiscoveryCandidate;
    onclose: () => void;
  }

  let { candidate, onclose }: Props = $props();

  // The parent keys this modal per candidate, so the initial value is enough.
  let label = $state(untrack(() => suggestLabel(candidate)));
  let busy = $state(false);

  async function adopt(): Promise<void> {
    const trimmed = label.trim();
    if (!trimmed || busy) return;
    busy = true;
    try {
      await api.createProfile({
        provider: candidate.provider,
        label: trimmed,
        home: candidate.home,
      });
      await refreshAll();
      toast('Profile added', `${trimmed} now points at ${candidate.home}`);
      onclose();
    } catch (error) {
      toastError(error, 'Could not adopt this home');
    } finally {
      busy = false;
    }
  }

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    void adopt();
  }
</script>

<Modal
  title="Adopt this home"
  subtitle="apm reads it in place — nothing is copied or moved."
  {onclose}
>
  <div class="summary">
    <div class="row">
      <ProviderBadge provider={candidate.provider} />
      <span class="mono truncate" title={candidate.home}>{candidate.home}</span>
    </div>
    {#if candidate.identity?.account}
      <p class="identity">
        {candidate.identity.account}{candidate.identity.plan ? ` · ${candidate.identity.plan}` : ''}
      </p>
    {:else}
      <p class="identity">No account identity could be read from this home.</p>
    {/if}
  </div>

  <form onsubmit={submit}>
    <div class="field">
      <label class="label" for="adopt-label">Profile name</label>
      <input
        id="adopt-label"
        class="input"
        bind:value={label}
        data-autofocus
        maxlength="64"
        autocomplete="off"
        placeholder="work"
      />
      <p class="hint">Shown on the dashboard and used by <code>apm run &lt;name&gt;</code>.</p>
    </div>
    <button type="submit" hidden aria-hidden="true"></button>
  </form>

  {#snippet footer()}
    <Button variant="ghost" onclick={onclose}>Cancel</Button>
    <Button
      variant="primary"
      loading={busy}
      disabled={label.trim().length === 0}
      onclick={() => void adopt()}
    >
      Add profile
    </Button>
  {/snippet}
</Modal>

<style>
  .summary {
    padding: 10px 12px;
    margin-bottom: 16px;
    background: var(--fill-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }

  .row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .identity {
    margin-top: 6px;
    font-size: 12px;
    color: var(--muted-fg);
  }

  .hint code {
    font-family: var(--font-mono);
  }
</style>
