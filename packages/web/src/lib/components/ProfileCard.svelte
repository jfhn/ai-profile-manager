<script lang="ts">
  import type { Profile, UsageSnapshot, UsageWindow } from '@apm/shared';
  import { api } from '../api';
  import { app, refreshAll } from '../stores.svelte';
  import { timeAgo, timeUntil, timeUntilFrom, absolute } from '../time.svelte';
  import { toast, toastError } from '../toasts.svelte';
  import Badge from './Badge.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import IconButton from './IconButton.svelte';
  import Menu from './Menu.svelte';
  import type { MenuItem } from './Menu.svelte';
  import Modal from './Modal.svelte';
  import Button from './Button.svelte';
  import ProgressBar from './ProgressBar.svelte';
  import ProviderBadge from './ProviderBadge.svelte';
  import WizardModal from './WizardModal.svelte';

  interface Props {
    profile: Profile;
    snapshot: UsageSnapshot | undefined;
  }

  let { profile, snapshot }: Props = $props();

  let refreshing = $state(false);
  let renaming = $state(false);
  let renameValue = $state('');
  let renameBusy = $state(false);
  let removing = $state(false);
  let removeBusy = $state(false);
  let purge = $state(false);
  /** The login wizard was reopened for this pending profile — never automatic. */
  let resuming = $state(false);

  const WINDOW_ORDER = ['five_hour', 'weekly', 'monthly'];

  const windows = $derived(
    [...(snapshot?.windows ?? [])].sort((a, b) => {
      const ai = WINDOW_ORDER.indexOf(a.id);
      const bi = WINDOW_ORDER.indexOf(b.id);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    }),
  );

  const plan = $derived(profile.identity?.plan ?? snapshot?.planType ?? null);

  const identityLine = $derived(
    [profile.identity?.account, profile.identity?.organization].filter(Boolean).join(' · '),
  );

  const retryIn = $derived(
    snapshot ? timeUntilFrom(snapshot.fetchedAt, snapshot.retryAfterSeconds) : null,
  );

  function remainingOf(window: UsageWindow): number | null {
    if (window.remainingPercent !== null) return window.remainingPercent;
    if (window.usedPercent !== null) return 100 - window.usedPercent;
    return null;
  }

  function toneOf(remaining: number): 'success' | 'warning' | 'destructive' {
    if (remaining >= 50) return 'success';
    if (remaining >= 20) return 'warning';
    return 'destructive';
  }

  async function refresh(): Promise<void> {
    if (refreshing) return;
    refreshing = true;
    try {
      const fresh = await api.refreshProfile(profile.id);
      // The daemon also broadcasts usage-updated; patch eagerly when it answers
      // with the snapshot so the card settles immediately.
      if (fresh && Array.isArray(fresh.windows)) {
        app.usage = { ...app.usage, [profile.id]: fresh };
      }
    } catch (error) {
      toastError(error, `Could not refresh ${profile.label}`);
    } finally {
      refreshing = false;
    }
  }

  function openRename(): void {
    renameValue = profile.label;
    renaming = true;
  }

  function submitRename(event: SubmitEvent): void {
    event.preventDefault();
    void applyRename();
  }

  async function applyRename(): Promise<void> {
    const label = renameValue.trim();
    if (!label || label === profile.label) {
      renaming = false;
      return;
    }
    renameBusy = true;
    try {
      await api.updateProfile(profile.id, { label });
      renaming = false;
      await refreshAll();
      toast('Profile renamed');
    } catch (error) {
      toastError(error, 'Rename failed');
    } finally {
      renameBusy = false;
    }
  }

  async function toggleEnabled(): Promise<void> {
    try {
      await api.updateProfile(profile.id, { enabled: !profile.enabled });
      await refreshAll();
    } catch (error) {
      toastError(error, profile.enabled ? 'Could not disable profile' : 'Could not enable profile');
    }
  }

  async function confirmRemove(): Promise<void> {
    removeBusy = true;
    try {
      await api.deleteProfile(profile.id, purge);
      removing = false;
      await refreshAll();
      toast('Profile removed', purge ? 'Its managed home was deleted too.' : undefined);
    } catch (error) {
      toastError(error, 'Could not remove profile');
    } finally {
      removeBusy = false;
    }
  }

  const menuItems = $derived<MenuItem[]>([
    ...(profile.status === 'pending'
      ? [{ label: 'Resume login', onSelect: () => (resuming = true) }]
      : []),
    { label: 'Rename', onSelect: openRename },
    { label: profile.enabled ? 'Disable' : 'Enable', onSelect: () => void toggleEnabled() },
    {
      label: 'Remove',
      danger: true,
      onSelect: () => {
        purge = false;
        removing = true;
      },
    },
  ]);
</script>

<article class="card" class:disabled={!profile.enabled}>
  <div class="head">
    <ProviderBadge provider={profile.provider} />
    <h3 class="name truncate" title={profile.label}>{profile.label}</h3>
    {#if plan}<Badge>{plan}</Badge>{/if}
    {#if !profile.enabled}<Badge>disabled</Badge>{/if}
    {#if profile.status === 'pending'}<Badge tone="warning">pending</Badge>{/if}
    <div class="spacer"></div>
    <IconButton
      icon="refresh"
      label={`Refresh usage for ${profile.label}`}
      spinning={refreshing}
      disabled={refreshing || !profile.enabled}
      onclick={() => void refresh()}
    />
    <Menu items={menuItems} label={`Actions for ${profile.label}`} />
  </div>

  <p class="identity truncate" title={profile.home}>
    {#if identityLine}
      {identityLine}
    {:else}
      <span class="mono">{profile.home}</span>
    {/if}
  </p>

  <div class="usage">
    {#if profile.status === 'error' && profile.statusReason}
      <p class="note error">{profile.statusReason}</p>
    {:else if windows.length > 0}
      {#each windows as window (window.id)}
        {@const remaining = remainingOf(window)}
        <div class="window">
          <span class="win-label">{window.label}</span>
          {#if remaining === null}
            <ProgressBar value={0} tone="muted" label={window.label} />
            <div class="win-right">
              <span class="win-pct muted">not reported</span>
            </div>
          {:else}
            <ProgressBar value={remaining} tone={toneOf(remaining)} label={window.label} />
            <div class="win-right">
              <span class="win-pct">{Math.round(remaining)}% left</span>
              {#if window.resetAt}
                {@const until = timeUntil(window.resetAt)}
                <span class="win-reset" title={absolute(window.resetAt)}>
                  {until ? `resets in ${until}` : 'resetting now'}
                </span>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    {:else if snapshot?.staleReason}
      <p class="note">{snapshot.staleReason}</p>
    {:else if snapshot?.error}
      <p class="note error">{snapshot.error}</p>
    {:else if !profile.enabled}
      <p class="note">Refreshing is paused while this profile is disabled.</p>
    {:else if profile.status === 'pending'}
      <div class="pending">
        <p class="note">Waiting for the login to finish in your terminal.</p>
        <Button size="sm" onclick={() => (resuming = true)}>Resume login</Button>
      </div>
    {:else}
      <p class="note">No usage collected yet.</p>
    {/if}
  </div>

  <div class="foot">
    {#if snapshot}
      <span class="truncate" title={snapshot.source}>{snapshot.source}</span>
      <span class="dot-sep">·</span>
      <span title={absolute(snapshot.fetchedAt)}>updated {timeAgo(snapshot.fetchedAt)}</span>
    {:else}
      <span>never refreshed</span>
    {/if}
    <div class="foot-badges">
      {#if snapshot?.stale}
        <Badge
          tone="warning"
          title={snapshot.staleReason ?? 'Data is older than the freshness horizon'}
        >
          stale
        </Badge>
      {/if}
      {#if snapshot?.failureKind}
        <Badge tone="destructive" title={snapshot.error ?? snapshot.failureKind}>
          {snapshot.failureKind === 'auth' ? 'auth' : 'error'}
        </Badge>
      {/if}
      {#if snapshot?.cacheStatus === 'cooldown'}
        <Badge title="A previous fetch failed; apm is waiting before retrying">
          cooldown{retryIn ? ` · ${retryIn}` : ''}
        </Badge>
      {/if}
    </div>
  </div>
</article>

{#if renaming}
  <Modal title="Rename profile" width={400} onclose={() => (renaming = false)}>
    <form onsubmit={submitRename}>
      <div class="field">
        <label class="label" for="rename-input">Profile name</label>
        <input
          id="rename-input"
          class="input"
          bind:value={renameValue}
          data-autofocus
          maxlength="64"
          autocomplete="off"
        />
        <p class="hint">Names are unique per provider.</p>
      </div>
      <button type="submit" hidden aria-hidden="true"></button>
    </form>
    {#snippet footer()}
      <Button variant="ghost" onclick={() => (renaming = false)}>Cancel</Button>
      <Button variant="primary" loading={renameBusy} onclick={() => void applyRename()}>Save</Button
      >
    {/snippet}
  </Modal>
{/if}

{#if resuming}
  <WizardModal resumeProfileId={profile.id} onclose={() => (resuming = false)} />
{/if}

{#if removing}
  <ConfirmDialog
    title={`Remove ${profile.label}?`}
    message={profile.homeKind === 'managed'
      ? 'The profile is removed from apm. Its managed home stays on disk unless you delete it below.'
      : 'The profile is removed from apm. The directory it points at is left untouched.'}
    confirmLabel="Remove"
    busy={removeBusy}
    onconfirm={() => void confirmRemove()}
    oncancel={() => (removing = false)}
  >
    {#snippet extra()}
      {#if profile.homeKind === 'managed'}
        <label class="checkbox">
          <input type="checkbox" bind:checked={purge} />
          <span>
            Also delete its files
            <span class="mono path">{profile.home}</span>
          </span>
        </label>
      {/if}
    {/snippet}
  </ConfirmDialog>
{/if}

<style>
  .card {
    display: flex;
    flex-direction: column;
    padding: 14px;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    transition:
      border-color 120ms ease,
      opacity 120ms ease;
  }

  .card:hover {
    border-color: var(--border-hover);
  }

  .card.disabled {
    opacity: 0.55;
  }

  .head {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .name {
    font-size: 13px;
    font-weight: 600;
    max-width: 40%;
  }

  .identity {
    margin-top: 8px;
    font-size: 12px;
    color: var(--muted-fg);
  }

  .usage {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 16px;
    margin-bottom: 16px;
    min-height: 44px;
  }

  .window {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .win-label {
    width: 24px;
    flex: none;
    font-size: 12px;
    color: var(--muted-fg);
  }

  .win-right {
    flex: none;
    min-width: 96px;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    line-height: 1.3;
  }

  .win-pct {
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }

  .win-reset {
    font-size: 11px;
    color: var(--muted-fg);
  }

  .note {
    font-size: 12px;
    color: var(--muted-fg);
  }

  .note.error {
    color: color-mix(in oklab, var(--destructive) 80%, var(--tint-contrast));
  }

  .pending {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
  }

  .foot {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    row-gap: 8px;
    /* auto keeps footers aligned across a row of unequal cards */
    margin-top: auto;
    padding-top: 10px;
    border-top: 1px solid var(--border);
    font-size: 11px;
    color: var(--muted-fg);
  }

  .foot > span {
    white-space: nowrap;
  }

  .dot-sep {
    opacity: 0.5;
  }

  .foot-badges {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-left: auto;
    padding-left: 6px;
  }

  .checkbox {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    font-size: 12px;
    color: var(--fg);
    cursor: pointer;
  }

  .checkbox input {
    margin-top: 2px;
    accent-color: var(--primary);
  }

  .path {
    display: block;
    color: var(--muted-fg);
    overflow-wrap: anywhere;
  }
</style>
