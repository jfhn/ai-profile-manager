<script lang="ts">
  import { untrack } from 'svelte';
  import type { ExecutionTarget, TargetCandidate } from '@apm/shared';
  import { api } from '../api';
  import { toast, toastError } from '../toasts.svelte';
  import Badge from './Badge.svelte';
  import Button from './Button.svelte';
  import Modal from './Modal.svelte';

  interface Props {
    candidate: TargetCandidate;
    onclose: () => void;
    /** The approved target, so the caller can refresh without a round trip. */
    onadded: (target: ExecutionTarget) => void;
  }

  let { candidate, onclose, onadded }: Props = $props();

  // Seeded once: the dialog exists for exactly one candidate, and a later
  // refresh must not overwrite what the user is typing.
  let label = $state(untrack(() => candidate.hostname || candidate.address));
  let id = $state(untrack(() => candidate.suggestedId));
  let busy = $state(false);

  const canSubmit = $derived(label.trim().length > 0 && id.trim().length > 0 && !busy);

  async function submit(): Promise<void> {
    if (!canSubmit) return;
    busy = true;
    try {
      // The address is the machine's own tailnet name, straight from the scan —
      // approving is choosing a machine, never typing a host.
      const target = await api.addTarget({
        id: id.trim(),
        label: label.trim(),
        address: candidate.address,
      });
      toast('Target added', `apm may now run work on ${label.trim()}.`);
      onadded(target);
    } catch (error) {
      toastError(error, 'Could not add the target');
    } finally {
      busy = false;
    }
  }
</script>

<Modal
  title={`Add ${candidate.hostname || candidate.address}`}
  subtitle="Approving a machine lets apm run work on it. Only do this for machines you control."
  width={440}
  {onclose}
>
  <form
    class="form"
    onsubmit={(event) => {
      event.preventDefault();
      void submit();
    }}
  >
    <div class="machine">
      <div class="machine-head">
        <span class="mono truncate" title={candidate.address}>{candidate.address}</span>
        <Badge tone={candidate.online ? 'success' : 'neutral'}>
          {candidate.online ? 'online' : 'offline'}
        </Badge>
      </div>
      <p class="hint">
        On your tailnet{candidate.os ? ` · ${candidate.os}` : ''}. apm reaches it over SSH as your
        own user; credentials stay on the machine that owns them.
      </p>
    </div>

    <div class="field">
      <label class="label" for="target-label">Label</label>
      <input
        id="target-label"
        class="input"
        bind:value={label}
        data-autofocus
        maxlength="64"
        autocomplete="off"
      />
    </div>

    <div class="field">
      <label class="label" for="target-id">Target id</label>
      <input id="target-id" class="input mono" bind:value={id} maxlength="64" autocomplete="off" />
      <p class="hint">
        Used by <code>apm run --target</code>. Letters, digits, <code>.</code>, <code>_</code> and
        <code>-</code>.
      </p>
    </div>

    <button type="submit" hidden aria-hidden="true"></button>
  </form>

  {#snippet footer()}
    <Button variant="ghost" onclick={onclose}>Cancel</Button>
    <Button variant="primary" loading={busy} disabled={!canSubmit} onclick={() => void submit()}>
      Add target
    </Button>
  {/snippet}
</Modal>

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .machine {
    padding: 10px 12px;
    background: var(--fill-5);
    border-radius: var(--radius-sm);
  }

  .machine-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .machine .hint {
    margin-top: 6px;
  }

  code {
    padding: 1px 4px;
    font-family: var(--font-mono);
    color: var(--fg);
    background: var(--fill-7);
    border-radius: 4px;
  }
</style>
