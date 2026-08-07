<script lang="ts">
  import { api } from '../lib/api';
  import { app, loadDiscovery } from '../lib/stores.svelte';
  import { toastError } from '../lib/toasts.svelte';
  import Button from '../lib/components/Button.svelte';
  import CardSkeleton from '../lib/components/CardSkeleton.svelte';
  import EmptyState from '../lib/components/EmptyState.svelte';
  import Icon from '../lib/components/Icon.svelte';
  import PageHeader from '../lib/components/PageHeader.svelte';
  import ProfileCard from '../lib/components/ProfileCard.svelte';
  import SuggestedStrip from '../lib/components/SuggestedStrip.svelte';
  import WizardModal from '../lib/components/WizardModal.svelte';

  let wizardOpen = $state(false);
  let refreshingAll = $state(false);

  // Usable profiles first, then by provider and name — disabled ones sink to the
  // end so the grid reads as "what can I use right now".
  const profiles = $derived(
    [...app.profiles].sort(
      (a, b) =>
        Number(b.enabled) - Number(a.enabled) ||
        a.provider.localeCompare(b.provider) ||
        a.label.localeCompare(b.label),
    ),
  );

  const runningSessions = $derived(
    app.sessions.filter((session) => session.status === 'running').length,
  );

  const summary = $derived(
    [
      `${profiles.length} ${profiles.length === 1 ? 'profile' : 'profiles'}`,
      runningSessions > 0
        ? `${runningSessions} running ${runningSessions === 1 ? 'session' : 'sessions'}`
        : null,
      app.t3Instances.some((instance) => instance.status === 'running')
        ? `${app.t3Instances.filter((instance) => instance.status === 'running').length} T3 running`
        : null,
    ]
      .filter(Boolean)
      .join(' · '),
  );

  async function refreshEverything(): Promise<void> {
    if (refreshingAll) return;
    refreshingAll = true;
    try {
      await api.refreshAll();
      await loadDiscovery();
    } catch (error) {
      toastError(error, 'Refresh failed');
    } finally {
      refreshingAll = false;
    }
  }
</script>

<div class="page">
  <PageHeader title="Dashboard" subtitle={app.loading ? 'Loading profiles…' : summary}>
    {#snippet actions()}
      <Button
        variant="ghost"
        loading={refreshingAll}
        disabled={app.loading || profiles.length === 0}
        onclick={() => void refreshEverything()}
      >
        {#if !refreshingAll}<Icon name="refresh" size={14} />{/if}
        Refresh all
      </Button>
      <Button variant="primary" onclick={() => (wizardOpen = true)}>
        <Icon name="plus" size={14} />
        Add profile
      </Button>
    {/snippet}
  </PageHeader>

  {#if app.loading}
    <div class="cards-grid">
      {#each [0, 1, 2] as index (index)}
        <CardSkeleton rows={index === 2 ? 1 : 2} />
      {/each}
    </div>
  {:else}
    <SuggestedStrip />

    {#if profiles.length === 0}
      <EmptyState
        title="No profiles yet"
        description="A profile binds one provider account to its own config home, so Claude and Codex sessions never share credentials. Add one to see quota, reset times and freshness at a glance."
        icon="sparkle"
        dashed
      >
        {#snippet action()}
          <Button variant="primary" onclick={() => (wizardOpen = true)}>
            <Icon name="plus" size={14} />
            Add profile
          </Button>
        {/snippet}
      </EmptyState>
    {:else}
      <div class="cards-grid">
        {#each profiles as profile (profile.id)}
          <ProfileCard {profile} snapshot={app.usage[profile.id]} />
        {/each}
      </div>
    {/if}
  {/if}
</div>

{#if wizardOpen}
  <WizardModal onclose={() => (wizardOpen = false)} />
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
</style>
