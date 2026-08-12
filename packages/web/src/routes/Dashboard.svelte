<script lang="ts">
  import { api } from '../lib/api';
  import { app, loadDiscovery } from '../lib/stores.svelte';
  import {
    buildTiles,
    buildVerdict,
    groupByProvider,
    profileView,
    qualifiedName,
    readCollapsed,
    writeCollapsed,
  } from '../lib/runway';
  import { now, timeAgo, timeUntil } from '../lib/time.svelte';
  import { toastError } from '../lib/toasts.svelte';
  import Button from '../lib/components/Button.svelte';
  import CardSkeleton from '../lib/components/CardSkeleton.svelte';
  import EmptyState from '../lib/components/EmptyState.svelte';
  import Icon from '../lib/components/Icon.svelte';
  import PageHeader from '../lib/components/PageHeader.svelte';
  import ProfileCard from '../lib/components/ProfileCard.svelte';
  import ProviderMark from '../lib/components/ProviderMark.svelte';
  import StatusDot from '../lib/components/StatusDot.svelte';
  import SuggestedStrip from '../lib/components/SuggestedStrip.svelte';
  import WizardModal from '../lib/components/WizardModal.svelte';

  let wizardOpen = $state(false);
  let refreshingAll = $state(false);

  const storage = typeof localStorage === 'undefined' ? null : localStorage;
  /** Provider ids (plus the pseudo-id 'disabled') whose section is folded away. */
  let collapsed = $state<string[]>(readCollapsed(storage));

  function isCollapsed(id: string): boolean {
    return collapsed.includes(id);
  }

  function toggleCollapsed(id: string): void {
    collapsed = isCollapsed(id) ? collapsed.filter((entry) => entry !== id) : [...collapsed, id];
    writeCollapsed(storage, collapsed);
  }

  // One shared clock drives every countdown, ring and roll-up on this page.
  const nowMs = $derived(now());

  const views = $derived(
    app.profiles.map((profile) => profileView(profile, app.usage[profile.id], nowMs)),
  );

  // Disabled profiles are not refreshed, so they say nothing about headroom.
  const active = $derived(views.filter((view) => view.profile.enabled));
  const disabled = $derived(
    views
      .filter((view) => !view.profile.enabled)
      .sort((a, b) => a.profile.label.localeCompare(b.profile.label)),
  );

  const groups = $derived(groupByProvider(active, (provider) => app.providerLabel(provider)));
  const singleProvider = $derived(groups.length === 1);
  const tiles = $derived(buildTiles(active));
  const verdict = $derived(buildVerdict(active));

  const nextResetLabel = $derived(
    tiles.nextReset.atMs === null ? null : timeUntil(new Date(tiles.nextReset.atMs).toISOString()),
  );
  const verdictResetLabel = $derived(
    verdict.resetAtMs === null ? null : timeUntil(new Date(verdict.resetAtMs).toISOString()),
  );

  const runningSessions = $derived(
    app.sessions.filter((session) => session.status === 'running').length,
  );

  const summary = $derived(
    [
      `${views.length} ${views.length === 1 ? 'profile' : 'profiles'}`,
      runningSessions > 0
        ? `${runningSessions} running ${runningSessions === 1 ? 'session' : 'sessions'}`
        : null,
    ]
      .filter(Boolean)
      .join(' · '),
  );

  function ownerLine(owner: {
    profileLabel: string;
    providerLabel: string;
    windowLabel: string | null;
  }): string {
    const name = `${owner.providerLabel} / ${owner.profileLabel}`;
    return owner.windowLabel ? `${name} · ${owner.windowLabel}` : name;
  }

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
        disabled={app.loading || views.length === 0}
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

    {#if views.length === 0}
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
      {#if active.length > 0}
        <p class="verdict {verdict.tone}">
          <StatusDot tone={verdict.tone} size={8} />
          {#if verdict.best}
            <span>
              Keep working on <strong>{qualifiedName(verdict.best)}</strong>
              — {Math.round(verdict.headroom ?? 0)}% headroom
            </span>
            <span class="sub">
              {#if verdict.worst}
                · {qualifiedName(verdict.worst)} is down to {Math.round(
                  verdict.worst.headroom ?? 0,
                )}%{verdictResetLabel ? `, its next reset is in ${verdictResetLabel}` : ''}
              {:else if verdictResetLabel}
                · next reset in {verdictResetLabel}
              {/if}
            </span>
          {:else}
            <span>No usage collected yet</span>
            <span class="sub">· refresh a profile to see its headroom</span>
          {/if}
        </p>

        <div class="tiles">
          <div class="tile">
            <span class="eyebrow">Tightest window</span>
            <span class="value {tiles.tightest.tone}">
              {#if tiles.tightest.remaining === null}
                —
              {:else}
                {Math.round(tiles.tightest.remaining)}<span class="unit">% left</span>
              {/if}
            </span>
            <span class="context truncate">
              {tiles.tightest.owner ? ownerLine(tiles.tightest.owner) : 'no usage reported'}
            </span>
          </div>
          <div class="tile">
            <span class="eyebrow">Next reset</span>
            <span class="value">{nextResetLabel ?? '—'}</span>
            <span class="context truncate">
              {tiles.nextReset.owner ? ownerLine(tiles.nextReset.owner) : 'no reset scheduled'}
            </span>
          </div>
          <div class="tile">
            <span class="eyebrow">At risk</span>
            <span class="value {tiles.atRisk.count > 0 ? tiles.atRisk.tone : ''}">
              {tiles.atRisk.count}<span class="unit"
                >/ {tiles.atRisk.total}
                {tiles.atRisk.total === 1 ? 'profile' : 'profiles'}</span
              >
            </span>
            <span class="context truncate">
              {tiles.atRisk.count} under 20% · {tiles.atRisk.underHalf} under 50%
            </span>
          </div>
          <div class="tile">
            <span class="eyebrow">Freshness</span>
            <span class="value {tiles.freshness.stale > 0 ? 'warning' : ''}">
              {tiles.freshness.stale}<span class="unit">stale</span>
            </span>
            <span class="context truncate">
              {tiles.freshness.oldestFetchedMs === null
                ? 'never refreshed'
                : `oldest ${timeAgo(new Date(tiles.freshness.oldestFetchedMs).toISOString())}`} ·
              {tiles.freshness.errors}
              {tiles.freshness.errors === 1 ? 'error' : 'errors'}
            </span>
          </div>
        </div>
      {/if}

      {#each groups as group (group.provider)}
        {@const folded = isCollapsed(group.provider)}
        <section class="section">
          <button
            type="button"
            class="section-head"
            aria-expanded={!folded}
            onclick={() => toggleCollapsed(group.provider)}
          >
            <ProviderMark provider={group.provider} />
            <h2 class="section-title">{group.label}</h2>
            <span class="rule"></span>
            <!-- With a single provider the tiles already carry this roll-up, so
                 the header keeps only its name and the collapse affordance. -->
            {#if !singleProvider}
              <span class="section-meta">
                <StatusDot tone={group.tone} size={7} />
                {group.profiles.length}
                {group.profiles.length === 1 ? 'profile' : 'profiles'}
                {group.headroom === null ? '' : `· ${Math.round(group.headroom)}% headroom`}
              </span>
            {/if}
            <span class="chevron" class:folded aria-hidden="true">
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor">
                <path
                  d="M4 6.5 8 10.5 12 6.5"
                  stroke-width="1.5"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </span>
          </button>
          {#if !folded}
            <div class="cards-grid">
              {#each group.profiles as view (view.profile.id)}
                <ProfileCard {view} />
              {/each}
            </div>
          {/if}
        </section>
      {/each}

      {#if disabled.length > 0}
        {@const folded = isCollapsed('disabled')}
        <section class="section">
          <button
            type="button"
            class="section-head muted-head"
            aria-expanded={!folded}
            onclick={() => toggleCollapsed('disabled')}
          >
            <StatusDot tone="muted" size={7} />
            <span class="section-title muted-title">
              Disabled · {disabled.length}
              {disabled.length === 1 ? 'profile' : 'profiles'}
            </span>
            <span class="rule"></span>
            <span class="section-meta truncate">refreshing paused</span>
            <span class="chevron" class:folded aria-hidden="true">
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor">
                <path
                  d="M4 6.5 8 10.5 12 6.5"
                  stroke-width="1.5"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </span>
          </button>
          {#if !folded}
            <div class="cards-grid">
              {#each disabled as view (view.profile.id)}
                <ProfileCard {view} />
              {/each}
            </div>
          {/if}
        </section>
      {/if}
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

  /* ---- verdict --------------------------------------------------------- */
  .verdict {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px;
    margin-bottom: 12px;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--fill-3);
    font-size: 15px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }

  .verdict.warning {
    border-color: color-mix(in oklab, var(--warning) 28%, transparent);
    background: color-mix(in oklab, var(--warning) 10%, transparent);
  }

  .verdict.destructive {
    border-color: color-mix(in oklab, var(--destructive) 28%, transparent);
    background: color-mix(in oklab, var(--destructive) 10%, transparent);
  }

  .verdict .sub {
    font-size: 13px;
    font-weight: 400;
    color: var(--muted-fg);
  }

  /* ---- stat tiles ------------------------------------------------------ */
  .tiles {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    margin-bottom: 24px;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: inset 0 1px 0 var(--surface-highlight);
    overflow: hidden;
  }

  .tile {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 14px 16px;
    min-width: 0;
    border-left: 1px solid var(--border);
  }

  .tile:first-child {
    border-left: none;
  }

  .eyebrow {
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted-fg);
  }

  .value {
    display: flex;
    align-items: baseline;
    gap: 5px;
    font-size: 28px;
    font-weight: 600;
    line-height: 1.15;
    letter-spacing: -0.02em;
    font-variant-numeric: tabular-nums;
  }

  .value .unit {
    font-size: 13px;
    font-weight: 500;
    letter-spacing: 0;
    color: var(--muted-fg);
  }

  .value.success {
    color: color-mix(in oklab, var(--success) 82%, var(--tint-contrast));
  }

  .value.warning {
    color: color-mix(in oklab, var(--warning) 82%, var(--tint-contrast));
  }

  .value.destructive {
    color: color-mix(in oklab, var(--destructive) 82%, var(--tint-contrast));
  }

  .context {
    font-size: 12px;
    color: var(--muted-fg);
  }

  /* ---- provider sections ----------------------------------------------- */
  .section {
    margin-bottom: 26px;
  }

  .section-head {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    margin-bottom: 12px;
    padding: 2px 0;
    border-radius: var(--radius-sm);
    text-align: left;
  }

  .section-head:hover .section-title,
  .section-head:hover .chevron {
    color: var(--fg);
  }

  .section-title {
    font-size: 15px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }

  .muted-head .section-title,
  .muted-title {
    font-size: 12px;
    font-weight: 500;
    color: var(--muted-fg);
  }

  .rule {
    flex: 1;
    min-width: 12px;
    height: 1px;
    background: var(--border);
  }

  .section-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--muted-fg);
  }

  .chevron {
    display: grid;
    place-items: center;
    flex: none;
    color: var(--muted-fg);
    /* app.css neutralises this under prefers-reduced-motion. */
    transition: transform 160ms ease;
  }

  .chevron.folded {
    transform: rotate(-90deg);
  }

  @media (max-width: 760px) {
    .tiles {
      grid-template-columns: repeat(2, 1fr);
    }

    .tile:nth-child(odd) {
      border-left: none;
    }

    .tile:nth-child(n + 3) {
      border-top: 1px solid var(--border);
    }
  }
</style>
