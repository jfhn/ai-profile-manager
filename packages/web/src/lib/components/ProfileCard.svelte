<script lang="ts">
  import { api } from '../api';
  import { app, refreshAll } from '../stores.svelte';
  import { formatPercent, type ProfileView } from '../runway';
  import { timeAgo, timeUntil, timeUntilFrom, absolute } from '../time.svelte';
  import { toast, toastError } from '../toasts.svelte';
  import Badge from './Badge.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import CopyProfileModal from './CopyProfileModal.svelte';
  import IconButton from './IconButton.svelte';
  import Menu from './Menu.svelte';
  import type { MenuItem } from './Menu.svelte';
  import Modal from './Modal.svelte';
  import Button from './Button.svelte';
  import ProgressBar from './ProgressBar.svelte';
  import ProviderMark from './ProviderMark.svelte';
  import StatusDot from './StatusDot.svelte';
  import TimeRing from './TimeRing.svelte';
  import WizardModal from './WizardModal.svelte';

  interface Props {
    view: ProfileView;
  }

  let { view }: Props = $props();

  const profile = $derived(view.profile);
  const snapshot = $derived(view.snapshot);
  const windows = $derived(view.windows);

  let refreshing = $state(false);
  let renaming = $state(false);
  let renameValue = $state('');
  let renameBusy = $state(false);
  let removing = $state(false);
  let copying = $state(false);
  let removeBusy = $state(false);
  let purge = $state(false);
  /** The login wizard was reopened for this pending profile — never automatic. */
  let resuming = $state(false);

  const plan = $derived(profile.identity?.plan ?? snapshot?.planType ?? null);

  const identityLine = $derived(
    [profile.identity?.account, profile.identity?.organization].filter(Boolean).join(' · '),
  );

  const retryIn = $derived(
    snapshot ? timeUntilFrom(snapshot.fetchedAt, snapshot.retryAfterSeconds) : null,
  );

  const isDefault = $derived(app.defaultProfileIds[profile.provider] === profile.id);
  /** Only launchable profiles carry the star — the daemon rejects the rest. */
  const starrable = $derived(profile.enabled && profile.status === 'active');
  const copyable = $derived(
    profile.status === 'active' && (profile.provider === 'claude' || profile.provider === 'codex'),
  );
  let settingDefault = $state(false);

  async function makeDefault(): Promise<void> {
    // There is always exactly one default per provider, so the active star is
    // inert rather than a toggle back to "no default".
    if (isDefault || settingDefault) return;
    settingDefault = true;
    try {
      const result = await api.setDefault(profile.provider, { profileId: profile.id });
      app.defaultProfileIds = result.defaultProfileIds;
    } catch (error) {
      toastError(error, `Could not make ${profile.label} the default`);
    } finally {
      settingDefault = false;
    }
  }

  async function refresh(): Promise<void> {
    if (refreshing) return;
    refreshing = true;
    try {
      await api.refreshProfile(profile.id);
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
    ...(copyable ? [{ label: 'Copy to machines', onSelect: () => (copying = true) }] : []),
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

<article
  class="card"
  style="--pcolor: var(--provider-{profile.provider}, var(--primary))"
  class:disabled={!profile.enabled}
  class:is-default={isDefault}
>
  <div class="head">
    <StatusDot
      tone={view.tone}
      title={view.headroom === null
        ? 'No usage reported'
        : `${formatPercent(view.headroom)}% left on ${view.tightest?.label}`}
    />
    <ProviderMark provider={profile.provider} />
    <h3 class="name truncate" title={profile.label}>{profile.label}</h3>
    {#if plan}<Badge>{plan}</Badge>{/if}
    {#if !profile.enabled}<Badge>disabled</Badge>{/if}
    {#if profile.status === 'pending'}<Badge tone="warning">pending</Badge>{/if}
    <div class="spacer"></div>
    {#if starrable}
      <button
        class="star"
        class:active={isDefault}
        type="button"
        aria-pressed={isDefault}
        title={isDefault
          ? `Default profile for ${app.providerLabel(profile.provider)}`
          : `Make this the default for ${app.providerLabel(profile.provider)}`}
        onclick={() => void makeDefault()}
      >
        <svg
          class="star-outline"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4 6.1 20.5l1.2-6.5L2.5 9.4l6.6-.9z" />
        </svg>
        <svg class="star-filled" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4 6.1 20.5l1.2-6.5L2.5 9.4l6.6-.9z" />
        </svg>
        <span>{isDefault ? 'Default' : 'Set default'}</span>
      </button>
    {/if}
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
        {@const until = timeUntil(window.resetAt)}
        <div class="window">
          <div class="usage-bar">
            <div class="usage-top">
              <span class="win-label truncate">{window.label}</span>
              {#if window.remaining === null}
                <span class="win-pct muted">not reported</span>
              {:else}
                <span class="win-pct {window.tone}">{formatPercent(window.remaining)}% left</span>
              {/if}
            </div>
            <ProgressBar
              value={window.remaining ?? 0}
              tone={window.tone}
              label={`${window.label} remaining`}
            />
          </div>
          <div class="time" class:none={!until}>
            <TimeRing
              elapsed={window.elapsedFraction}
              title={window.elapsedFraction === null
                ? 'Window length unknown'
                : `${Math.round(window.elapsedFraction * 100)}% of the window elapsed`}
            />
            <div class="time-text">
              {#if until}
                <span class="left" title={absolute(window.resetAt)}>{until}</span>
                <span class="cap">to reset</span>
              {:else if window.remaining === null}
                <span class="left">no data</span>
              {:else}
                <span class="left">not started</span>
              {/if}
            </div>
          </div>
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

{#if copying}
  <CopyProfileModal {profile} onclose={() => (copying = false)} />
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

  /* The default card gets a subtle provider-tinted ring so it reads at a glance. */
  .card.is-default {
    border-color: color-mix(in oklab, var(--pcolor) 45%, transparent);
  }

  .card.is-default:hover {
    border-color: color-mix(in oklab, var(--pcolor) 60%, transparent);
  }

  .card.disabled {
    opacity: 0.55;
  }

  /* The star is both indicator and control: filled + tinted on the default,
     dim outline on the others. Clicking a dim one moves the default here;
     the active one is inert (there is always exactly one default). */
  .star {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    flex: none;
    padding: 2px 8px 2px 6px;
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: var(--muted-fg);
    font: inherit;
    font-size: 10.5px;
    font-weight: 500;
    cursor: pointer;
    opacity: 0.55;
    transition:
      opacity 120ms ease,
      color 120ms ease,
      background 120ms ease;
  }

  .star svg {
    width: 12px;
    height: 12px;
    flex: none;
  }

  .star .star-filled {
    display: none;
  }

  .star:hover {
    opacity: 1;
    color: var(--fg);
    background: var(--hover);
  }

  .star.active {
    opacity: 1;
    cursor: default;
    background: color-mix(in oklab, var(--pcolor) 16%, transparent);
    color: color-mix(in oklab, var(--pcolor) 78%, var(--tint-contrast));
  }

  .star.active:hover {
    background: color-mix(in oklab, var(--pcolor) 16%, transparent);
  }

  .star.active .star-outline {
    display: none;
  }

  .star.active .star-filled {
    display: block;
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
    gap: 8px;
    margin-top: 14px;
    margin-bottom: 14px;
    min-height: 44px;
  }

  /* Usage bar on the left, the neutral time ring and countdown on the right. */
  .window {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: center;
    gap: 12px;
  }

  .usage-bar {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .usage-top {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: 11px;
  }

  .win-label {
    color: var(--muted-fg);
    letter-spacing: 0.02em;
  }

  .win-pct {
    margin-left: auto;
    flex: none;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }

  .win-pct.warning {
    color: color-mix(in oklab, var(--warning) 80%, var(--tint-contrast));
  }

  .win-pct.destructive {
    color: color-mix(in oklab, var(--destructive) 80%, var(--tint-contrast));
  }

  .win-pct.muted {
    color: var(--muted-fg);
  }

  .time {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: none;
  }

  .time-text {
    display: flex;
    flex-direction: column;
    line-height: 1.15;
    width: 54px;
  }

  .time-text .left {
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }

  .time-text .cap {
    font-size: 10px;
    color: var(--muted-fg);
  }

  .time.none .time-text .left {
    color: var(--muted-fg);
  }

  .note {
    font-size: 12px;
    color: var(--muted-fg);
  }

  .note.error {
    color: color-mix(in oklab, var(--destructive) 80%, var(--tint-contrast));
  }

  /* Same rhythm as .window: the text on the left, its control right-aligned. */
  .pending {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: center;
    gap: 12px;
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
