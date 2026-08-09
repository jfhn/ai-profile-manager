<script lang="ts">
  import { app, loadTargetProfiles, LOCAL_TARGET_ID } from '../lib/stores.svelte';
  import Button from '../lib/components/Button.svelte';
  import EmptyState from '../lib/components/EmptyState.svelte';
  import Icon from '../lib/components/Icon.svelte';
  import NewT3Modal from '../lib/components/NewT3Modal.svelte';
  import PageHeader from '../lib/components/PageHeader.svelte';
  import T3Card from '../lib/components/T3Card.svelte';

  let creating = $state(false);

  const instances = $derived([...app.t3Instances].sort((a, b) => a.label.localeCompare(b.label)));
  const running = $derived(instances.filter((instance) => instance.status === 'running').length);

  // A card resolves a remote binding against its own target's profile list, so
  // every target on this page needs that list read once. The loader caches and
  // de-duplicates, so a dozen instances on one target cost one request.
  $effect(() => {
    for (const targetId of new Set(instances.map((instance) => instance.targetId))) {
      if (targetId !== LOCAL_TARGET_ID) void loadTargetProfiles(targetId);
    }
  });
</script>

<div class="page">
  <PageHeader
    title="T3 Instances"
    subtitle={instances.length === 0
      ? 'Managed T3 Code servers, supervised by the daemon'
      : `${running} running · ${instances.length} total`}
  >
    {#snippet actions()}
      <Button variant="primary" onclick={() => (creating = true)}>
        <Icon name="plus" size={14} />
        New instance
      </Button>
    {/snippet}
  </PageHeader>

  {#if instances.length === 0}
    <EmptyState
      title="No instances yet"
      description="Run T3 Code against a specific account without touching your global config. Each instance gets its own port and base directory."
      icon="layers"
      dashed
    >
      {#snippet action()}
        <Button variant="primary" onclick={() => (creating = true)}>
          <Icon name="plus" size={14} />
          New instance
        </Button>
      {/snippet}
    </EmptyState>
  {:else}
    <div class="cards-grid">
      {#each instances as instance (instance.id)}
        <T3Card {instance} />
      {/each}
    </div>
    <p class="note">
      Each instance is a separate T3 Code server bound to the selected profiles, running on its own
      target. A remote instance is opened through the endpoint its target publishes.
    </p>
  {/if}
</div>

{#if creating}
  <NewT3Modal onclose={() => (creating = false)} />
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

  .note {
    margin-top: 16px;
    font-size: 11px;
    color: var(--muted-fg);
  }
</style>
