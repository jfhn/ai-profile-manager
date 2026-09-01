<script lang="ts">
  import type { ExecutionTarget, Profile, ProfileCopyTargetResult } from '@apm/shared';
  import { api, errorMessage } from '../api';
  import { app, LOCAL_TARGET_ID } from '../stores.svelte';
  import { toast, toastError } from '../toasts.svelte';
  import Badge from './Badge.svelte';
  import Button from './Button.svelte';
  import Modal from './Modal.svelte';
  import StatusDot from './StatusDot.svelte';

  interface Props {
    profile: Profile;
    onclose: () => void;
  }

  let { profile, onclose }: Props = $props();

  let selected = $state<string[]>([]);
  let results = $state<ProfileCopyTargetResult[]>([]);
  let requestError = $state<string | null>(null);
  let busy = $state(false);

  /** Only explicitly approved remotes advertising the enrollment capability are offered. */
  const targets = $derived(
    [...app.targets]
      .filter(
        (target) =>
          target.id !== LOCAL_TARGET_ID &&
          target.kind === 'remote' &&
          target.approved &&
          target.capabilities.includes('sync'),
      )
      .sort((a, b) => a.label.localeCompare(b.label)),
  );

  const incompatibleCount = $derived(
    app.targets.filter(
      (target) =>
        target.id !== LOCAL_TARGET_ID &&
        target.kind === 'remote' &&
        (!target.approved || !target.capabilities.includes('sync')),
    ).length,
  );

  const submitLabel = $derived(
    results.some((result) => result.status === 'failed')
      ? 'Retry failed'
      : selected.length === 0
        ? 'Copy profile'
        : selected.length === 1
          ? 'Copy to 1 machine'
          : `Copy to ${selected.length} machines`,
  );

  function resultFor(targetId: string): ProfileCopyTargetResult | undefined {
    return results.find((result) => result.targetId === targetId);
  }

  function toggle(targetId: string, checked: boolean): void {
    selected = checked
      ? [...selected, targetId]
      : selected.filter((candidate) => candidate !== targetId);
    results = [];
    requestError = null;
  }

  function selectAll(): void {
    selected = targets.map((target) => target.id);
    results = [];
    requestError = null;
  }

  function clearSelection(): void {
    selected = [];
    results = [];
    requestError = null;
  }

  function targetTone(target: ExecutionTarget): 'success' | 'muted' {
    return target.status === 'online' ? 'success' : 'muted';
  }

  function failureMessage(code: string): string {
    switch (code) {
      case 'unreachable':
      case 'closed':
      case 'timeout':
        return 'Machine unavailable';
      case 'unauthorized':
        return 'SSH authentication failed';
      case 'command-not-found':
        return 'apm was not found on this machine';
      case 'unsupported':
        return 'Update apm on this machine';
      case 'target-not-approved':
        return 'Machine is no longer approved';
      case 'target-not-found':
        return 'Machine is no longer registered';
      case 'sync-conflict':
        return 'This machine has a conflicting owner';
      default:
        return `Copy failed (${code})`;
    }
  }

  async function copy(): Promise<void> {
    if (busy || selected.length === 0) return;
    const requested = [...selected];
    busy = true;
    results = [];
    requestError = null;
    try {
      const response = await api.copyProfile(profile.id, { targetIds: requested });
      results = response.results;

      // Keep the shared dashboard state current without waiting for its SSE refetch.
      app.profiles = app.profiles.map((candidate) =>
        candidate.id === response.profile.id ? response.profile : candidate,
      );

      const copied = response.results.filter((result) => result.status === 'copied');
      const failed = response.results.filter((result) => result.status === 'failed');
      if (failed.length === 0) {
        const description =
          copied.length === 1
            ? `${profile.label} is now available on ${app.targetLabel(copied[0]?.targetId)}.`
            : `${profile.label} is now available on ${copied.length} machines.`;
        toast(
          copied.length === 1 ? 'Profile copied' : `Profile copied to ${copied.length} machines`,
          description,
        );
        onclose();
        return;
      }

      // A retry acts only on failed machines; successful enrollments are never repeated by accident.
      selected = failed.map((result) => result.targetId);
      if (copied.length > 0) {
        toast(
          `Copied to ${copied.length} of ${requested.length} machines`,
          'Review the failed machine below or retry it.',
        );
      } else {
        toastError(
          new Error('Review the machine errors below and retry.'),
          'Profile was not copied',
        );
      }
    } catch (error) {
      requestError = errorMessage(error);
      toastError(error, `Could not copy ${profile.label}`);
    } finally {
      busy = false;
    }
  }
</script>

<Modal
  title={`Copy ${profile.label}`}
  subtitle={`Send ${app.providerLabel(profile.provider)} credentials to selected machines`}
  width={520}
  {onclose}
>
  <div class="content">
    <p class="scope-note">
      Only provider credentials are sent over your existing SSH connection. Each destination gets a
      managed profile; chats, history, projects, caches, and other files stay here.
    </p>

    {#if targets.length === 0}
      <div class="empty surface">
        <p class="empty-title">No compatible targets</p>
        <p>
          Add an approved remote machine with a current version of apm, then copy this profile from
          here.
        </p>
      </div>
    {:else}
      <div class="picker-head">
        <span class="label">Machines</span>
        <button
          type="button"
          class="select-link"
          onclick={selected.length === targets.length ? clearSelection : selectAll}
        >
          {selected.length === targets.length ? 'Clear' : 'Select all'}
        </button>
      </div>

      <div class="targets surface">
        {#each targets as target (target.id)}
          {@const result = resultFor(target.id)}
          <label class="target" class:selected={selected.includes(target.id)}>
            <input
              type="checkbox"
              checked={selected.includes(target.id)}
              onchange={(event) => toggle(target.id, event.currentTarget.checked)}
            />
            <StatusDot tone={targetTone(target)} />
            <span class="names">
              <span class="name truncate">{target.label}</span>
              <span class="address mono truncate">{target.identity.address ?? target.id}</span>
            </span>
            <Badge tone={target.status === 'online' ? 'success' : 'neutral'}>{target.status}</Badge>
            {#if result?.status === 'copied'}
              <span class="result success">Copied as {result.profile.label}</span>
            {:else if result?.status === 'failed'}
              <span class="result failed">{failureMessage(result.errorCode)}</span>
            {/if}
          </label>
        {/each}
      </div>

      {#if incompatibleCount > 0}
        <p class="hint">
          {incompatibleCount} registered {incompatibleCount === 1 ? 'machine is' : 'machines are'}
          hidden because credential copying is unavailable there.
        </p>
      {/if}
    {/if}

    {#if requestError}
      <p class="request-error" role="alert">{requestError}</p>
    {/if}
  </div>

  {#snippet footer()}
    <Button variant="ghost" onclick={onclose}>Cancel</Button>
    {#if targets.length === 0}
      <Button variant="primary" href="#/targets">Manage targets</Button>
    {:else}
      <Button
        variant="primary"
        loading={busy}
        disabled={selected.length === 0}
        onclick={() => void copy()}
      >
        {submitLabel}
      </Button>
    {/if}
  {/snippet}
</Modal>

<style>
  .content {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .scope-note {
    padding: 10px 12px;
    border-radius: var(--radius-sm);
    background: var(--fill-4);
    color: var(--muted-fg);
    font-size: 12px;
  }

  .picker-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .select-link {
    color: var(--primary);
    font-size: 11px;
    cursor: pointer;
  }

  .select-link:hover {
    text-decoration: underline;
  }

  .targets {
    overflow: hidden;
  }

  .target {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 54px;
    padding: 9px 11px;
    cursor: pointer;
    transition: background 120ms ease;
  }

  .target + .target {
    border-top: 1px solid var(--border);
  }

  .target:hover,
  .target.selected {
    background: var(--fill-4);
  }

  .target input {
    flex: none;
    margin: 0;
    accent-color: var(--primary);
  }

  .names {
    display: flex;
    flex: 1;
    min-width: 0;
    flex-direction: column;
    gap: 1px;
  }

  .name {
    font-size: 13px;
    font-weight: 500;
  }

  .address {
    color: var(--muted-fg);
    font-size: 10.5px;
  }

  .result {
    max-width: 145px;
    font-size: 11px;
    text-align: right;
  }

  .result.success {
    color: color-mix(in oklab, var(--success) 78%, var(--tint-contrast));
  }

  .result.failed,
  .request-error {
    color: var(--destructive);
  }

  .empty {
    padding: 18px;
    color: var(--muted-fg);
    font-size: 12px;
    text-align: center;
  }

  .empty-title {
    margin-bottom: 3px;
    color: var(--fg);
    font-weight: 600;
  }

  .request-error {
    font-size: 12px;
  }
</style>
