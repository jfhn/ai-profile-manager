<script lang="ts">
  import type { ExecutionTarget, TargetCandidate } from '@apm/shared';
  import { api, errorMessage } from '../lib/api';
  import { app, loadTargets, LOCAL_TARGET_ID } from '../lib/stores.svelte';
  import { toast, toastError } from '../lib/toasts.svelte';
  import AddTargetModal from '../lib/components/AddTargetModal.svelte';
  import Badge from '../lib/components/Badge.svelte';
  import Button from '../lib/components/Button.svelte';
  import ConfirmDialog from '../lib/components/ConfirmDialog.svelte';
  import EmptyState from '../lib/components/EmptyState.svelte';
  import Icon from '../lib/components/Icon.svelte';
  import PageHeader from '../lib/components/PageHeader.svelte';
  import StatusDot from '../lib/components/StatusDot.svelte';

  let candidates = $state<TargetCandidate[]>([]);
  let scanning = $state(true);
  let scanError = $state<string | null>(null);
  let adding = $state<TargetCandidate | null>(null);
  let revoking = $state<ExecutionTarget | null>(null);
  let revokeBusy = $state(false);

  const registered = $derived(
    [...app.targets].sort((a, b) => {
      if (a.id === LOCAL_TARGET_ID) return -1;
      if (b.id === LOCAL_TARGET_ID) return 1;
      return a.label.localeCompare(b.label);
    }),
  );

  const remotes = $derived(registered.filter((target) => target.id !== LOCAL_TARGET_ID).length);

  /**
   * Discovery is a read of the tailnet, so it runs on open and on demand —
   * never on a timer, and never as a side effect of anything that changes the
   * approved set.
   */
  async function scan(): Promise<void> {
    scanning = true;
    try {
      candidates = await api.targetCandidates();
      scanError = null;
    } catch (error) {
      candidates = [];
      scanError = errorMessage(error);
    } finally {
      scanning = false;
    }
  }

  $effect(() => {
    // The page is reachable directly, so it does not rely on the boot fetch
    // having succeeded.
    void loadTargets();
    void scan();
  });

  /** After an approval both lists change: the registry and the "already added" state. */
  async function added(target: ExecutionTarget): Promise<void> {
    adding = null;
    // The T3 picker reads the same store, so the machine is offered there the
    // moment it is approved rather than after the next refetch.
    if (!app.target(target.id)) app.targets = [...app.targets, target];
    await loadTargets();
    await scan();
  }

  async function revoke(): Promise<void> {
    const target = revoking;
    if (!target) return;
    revokeBusy = true;
    try {
      await api.deleteTarget(target.id);
      revoking = null;
      toast('Target revoked', `apm closed its connection to ${target.label}.`);
      await loadTargets();
      await scan();
    } catch (error) {
      toastError(error, 'Could not revoke the target');
    } finally {
      revokeBusy = false;
    }
  }

  function statusTone(target: ExecutionTarget): 'success' | 'muted' | 'warning' {
    if (!target.approved) return 'warning';
    return target.status === 'online' ? 'success' : 'muted';
  }
</script>

<div class="page">
  <PageHeader
    title="Targets"
    subtitle={remotes === 0
      ? 'Machines apm may run work on — this one, plus any you approve'
      : `${remotes} approved remote ${remotes === 1 ? 'machine' : 'machines'} · plus this one`}
  >
    {#snippet actions()}
      <Button variant="ghost" loading={scanning} onclick={() => void scan()}>
        <Icon name="refresh" size={14} />
        Rescan tailnet
      </Button>
    {/snippet}
  </PageHeader>

  <section class="block">
    <h2 class="section-title">Registered</h2>
    <div class="rows surface">
      {#if registered.length === 0}
        <p class="row note">Waiting for the daemon's target list…</p>
      {/if}
      {#each registered as target (target.id)}
        <div class="row">
          <StatusDot tone={statusTone(target)} />
          <div class="names">
            <span class="name truncate" title={target.label}>{target.label}</span>
            <span class="mono muted truncate" title={target.identity.address ?? target.id}>
              {target.identity.address ?? target.id}
            </span>
          </div>
          <div class="tags">
            <Badge tone={target.kind === 'local' ? 'neutral' : 'primary'}>{target.kind}</Badge>
            {#if !target.approved}
              <Badge tone="warning" title="Registered but not approved — it runs nothing">
                not approved
              </Badge>
            {/if}
          </div>
          {#if target.id === LOCAL_TARGET_ID}
            <span class="note">always available</span>
          {:else}
            <Button
              size="sm"
              variant="ghost"
              title={`Revoke ${target.label}`}
              onclick={() => (revoking = target)}
            >
              Revoke
            </Button>
          {/if}
        </div>
      {/each}
    </div>
  </section>

  <section class="block">
    <div class="block-head">
      <h2 class="section-title">On your tailnet</h2>
      <span class="note">discovered, not approved</span>
    </div>

    {#if scanError}
      <div class="surface notice">
        <Icon name="alert" size={16} />
        <div>
          <p class="notice-title">Cannot read your tailnet</p>
          <p class="hint">{scanError}</p>
        </div>
        <div class="spacer"></div>
        <Button size="sm" loading={scanning} onclick={() => void scan()}>Try again</Button>
      </div>
    {:else if candidates.length === 0}
      <EmptyState
        title={scanning ? 'Scanning your tailnet…' : 'No other machines on your tailnet'}
        description="apm only ever offers machines your tailnet already lets this one see. Add a device to the tailnet and rescan."
        icon="monitor"
        dashed
      />
    {:else}
      <div class="rows surface">
        {#each candidates as candidate (candidate.address || candidate.hostname)}
          <div class="row">
            <StatusDot tone={candidate.online ? 'success' : 'muted'} />
            <div class="names">
              <span class="name truncate" title={candidate.hostname}>{candidate.hostname}</span>
              <span class="mono muted truncate" title={candidate.address}>{candidate.address}</span>
            </div>
            <div class="tags">
              <Badge tone={candidate.online ? 'success' : 'neutral'}>
                {candidate.online ? 'online' : 'offline'}
              </Badge>
              {#if candidate.os}<Badge>{candidate.os}</Badge>{/if}
            </div>
            {#if candidate.registeredTargetId}
              <span class="note">added as {candidate.registeredTargetId}</span>
            {:else}
              <Button
                size="sm"
                variant="primary"
                title={`Add ${candidate.hostname} as a target`}
                onclick={() => (adding = candidate)}
              >
                <Icon name="plus" size={13} />
                Add
              </Button>
            {/if}
          </div>
        {/each}
      </div>
    {/if}

    <p class="note foot">
      Machines are listed straight from this machine's tailnet. Listing one grants nothing — apm
      runs work on a machine only after you add it here, and revoking closes its connection at once.
      The approved set lives in <code class="mono">targets.json</code>.
    </p>
  </section>
</div>

{#if adding}
  <AddTargetModal
    candidate={adding}
    onclose={() => (adding = null)}
    onadded={(target) => void added(target)}
  />
{/if}

{#if revoking}
  <ConfirmDialog
    title={`Revoke ${revoking.label}?`}
    message={`apm stops running work on ${revoking.label} and closes its connection right away. Anything still running there keeps running, and you can add the machine again later.`}
    confirmLabel="Revoke"
    busy={revokeBusy}
    onconfirm={() => void revoke()}
    oncancel={() => (revoking = null)}
  />
{/if}

<style>
  .page {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 24px;
  }

  .page > :global(*) {
    max-width: 1200px;
    margin-inline: auto;
  }

  .block {
    margin-bottom: 28px;
  }

  .block-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }

  .rows {
    margin-top: 12px;
    overflow: hidden;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    min-width: 0;
  }

  .row + .row {
    border-top: 1px solid var(--border);
  }

  .names {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1;
  }

  .name {
    font-size: 13px;
    font-weight: 500;
  }

  .tags {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: none;
  }

  .note {
    font-size: 11px;
    color: var(--muted-fg);
  }

  .foot {
    margin-top: 12px;
  }

  .notice {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 12px;
    padding: 12px 14px;
    color: var(--muted-fg);
  }

  .notice-title {
    font-size: 13px;
    font-weight: 500;
    color: var(--fg);
  }

  code {
    padding: 1px 4px;
    color: var(--fg);
    background: var(--fill-7);
    border-radius: 4px;
  }
</style>
