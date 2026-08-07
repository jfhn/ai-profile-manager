<script lang="ts">
  import type { DiscoveryCandidate } from '@apm/shared';
  import { app } from '../stores.svelte';
  import AdoptModal from './AdoptModal.svelte';
  import Badge from './Badge.svelte';
  import Button from './Button.svelte';
  import ProviderBadge from './ProviderBadge.svelte';

  let selected = $state<DiscoveryCandidate | null>(null);

  const candidates = $derived(app.discovery);
</script>

{#if candidates.length > 0}
  <section class="strip surface" aria-label="Suggested profiles">
    <header>
      <h2 class="section-title">Suggested</h2>
      <p class="hint">
        {candidates.length === 1 ? 'One provider home' : `${candidates.length} provider homes`} on this
        machine aren't managed by apm yet.
      </p>
    </header>

    <ul>
      {#each candidates as candidate (candidate.provider + candidate.home)}
        <li>
          <ProviderBadge provider={candidate.provider} />
          <span class="home mono truncate" title={candidate.home}>{candidate.home}</span>
          <span class="identity truncate">
            {candidate.identity?.account ??
              (candidate.hasCredentials ? 'identity unknown' : 'not logged in')}
          </span>
          {#if candidate.isDefault}
            <Badge title="The provider's global default home">default</Badge>
          {/if}
          {#if !candidate.hasCredentials}
            <Badge tone="warning">no credentials</Badge>
          {/if}
          <div class="spacer"></div>
          <Button size="sm" onclick={() => (selected = candidate)}>Adopt</Button>
        </li>
      {/each}
    </ul>
  </section>
{/if}

{#if selected}
  {#key selected.home}
    <AdoptModal candidate={selected} onclose={() => (selected = null)} />
  {/key}
{/if}

<style>
  .strip {
    margin-bottom: 24px;
    padding: 14px;
  }

  header {
    margin-bottom: 10px;
  }

  .hint {
    margin-top: 2px;
  }

  ul {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 36px;
    padding: 0 8px;
    border-radius: var(--radius-sm);
    transition: background 120ms ease;
  }

  li:hover {
    background: var(--hover);
  }

  .home {
    max-width: 46%;
    color: var(--fg);
  }

  .identity {
    font-size: 12px;
    color: var(--muted-fg);
    max-width: 30%;
  }

  .strip :global(.hint) {
    font-size: 12px;
  }
</style>
