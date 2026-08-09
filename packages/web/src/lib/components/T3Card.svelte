<script lang="ts">
  import type { EndpointScope, ProviderId, T3Instance } from '@apm/shared';
  import { api } from '../api';
  import { app, LOCAL_TARGET_ID } from '../stores.svelte';
  import { toast, toastError } from '../toasts.svelte';
  import Badge from './Badge.svelte';
  import Button from './Button.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import Menu from './Menu.svelte';
  import type { MenuItem } from './Menu.svelte';
  import StatusDot from './StatusDot.svelte';

  interface Props {
    instance: T3Instance;
  }

  let { instance }: Props = $props();

  let busy = $state(false);
  let removing = $state(false);
  let removeBusy = $state(false);

  const removable = $derived(instance.status === 'stopped' || instance.status === 'exited');

  const tone = $derived(
    instance.status === 'running'
      ? 'success'
      : instance.status === 'starting' || instance.status === 'unhealthy'
        ? 'warning'
        : 'muted',
  );

  const remote = $derived(instance.targetId !== LOCAL_TARGET_ID);
  const failed = $derived(instance.status === 'unhealthy' || instance.status === 'exited');
  const scope = $derived<EndpointScope | null>(instance.endpoint?.scope ?? null);

  /**
   * Spelled out rather than implied by the URL: a forwarded endpoint also looks
   * like a localhost link, and only the scope says whether another device can
   * reach it.
   */
  const endpointHint = $derived(
    scope === 'published'
      ? `Published on ${app.targetLabel(instance.targetId)}'s own address — reachable from your trusted network.`
      : scope === 'forwarded'
        ? 'Forwarded through the machine running apm — this link only opens here.'
        : 'Served by the machine running apm.',
  );

  const bound = $derived(
    (Object.entries(instance.profiles) as Array<[ProviderId, string | undefined]>)
      .filter((entry): entry is [ProviderId, string] => Boolean(entry[1]))
      .map(([provider, profileId]) => ({
        provider,
        label: app.profile(profileId)?.label ?? 'missing profile',
      })),
  );

  async function run(action: 'start' | 'stop'): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const updated =
        action === 'start' ? await api.startT3(instance.id) : await api.stopT3(instance.id);
      if (updated && typeof updated.id === 'string') {
        app.t3Instances = app.t3Instances.map((item) => (item.id === updated.id ? updated : item));
      }
    } catch (error) {
      toastError(
        error,
        action === 'start' ? 'Could not start the instance' : 'Could not stop the instance',
      );
    } finally {
      busy = false;
    }
  }

  async function remove(): Promise<void> {
    removeBusy = true;
    try {
      await api.deleteT3(instance.id);
      app.t3Instances = app.t3Instances.filter((item) => item.id !== instance.id);
      removing = false;
      toast('Instance removed', instance.label);
    } catch (error) {
      toastError(error, 'Could not remove the instance');
    } finally {
      removeBusy = false;
    }
  }

  const menuItems = $derived<MenuItem[]>([
    {
      label: 'Remove',
      danger: true,
      disabled: !removable,
      onSelect: () => (removing = true),
    },
  ]);
</script>

<article class="card">
  <div class="head">
    <StatusDot {tone} pulse={instance.status === 'starting' || instance.status === 'unhealthy'} />
    <h3 class="name truncate" title={instance.label}>{instance.label}</h3>
    <Badge>{instance.status}</Badge>
    <div class="spacer"></div>
    <Menu items={menuItems} label={`Actions for ${instance.label}`} />
  </div>

  <dl class="rows">
    <div class="row">
      <dt>target</dt>
      <dd class="inline">
        <span class="truncate" title={instance.targetId}>{app.targetLabel(instance.targetId)}</span>
        <Badge tone={remote ? 'primary' : 'neutral'}>{remote ? 'remote' : 'local'}</Badge>
      </dd>
    </div>
    {#if instance.endpoint}
      <div class="row">
        <dt>endpoint</dt>
        <dd class="inline">
          <Badge tone={scope === 'published' ? 'success' : 'warning'} title={endpointHint}>
            {scope}
          </Badge>
          <span class="mono truncate" title={instance.url ?? undefined}>
            {instance.url ?? 'no URL yet'}
          </span>
        </dd>
      </div>
    {/if}
    <div class="row">
      <dt>port</dt>
      <dd class="mono">{instance.port ?? '—'}</dd>
    </div>
    <div class="row">
      <dt>base dir</dt>
      <dd class="mono truncate" title={instance.baseDir}>{instance.baseDir}</dd>
    </div>
    <div class="row">
      <dt>profiles</dt>
      <dd class="profiles">
        {#if bound.length === 0}
          <span class="muted">none</span>
        {:else}
          {#each bound as entry (entry.provider)}
            <Badge tone={entry.provider === 'claude' ? 'claude' : 'codex'}>
              {app.providerLabel(entry.provider)} · {entry.label}
            </Badge>
          {/each}
        {/if}
      </dd>
    </div>
  </dl>

  {#if instance.endpoint}
    <p class="hint">{endpointHint}</p>
  {/if}

  {#if instance.statusReason}
    <!-- A reason on a stopped instance explains why it is stopped, which is
         information rather than a failure. -->
    <p class={failed ? 'reason' : 'hint'}>{instance.statusReason}</p>
  {/if}

  <div class="foot">
    {#if instance.status === 'starting'}
      <Button size="sm" variant="primary" disabled>Starting…</Button>
    {:else if instance.status === 'running' || instance.status === 'unhealthy'}
      {#if instance.url}
        <Button
          size="sm"
          variant="primary"
          href={instance.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open
        </Button>
      {/if}
      <Button size="sm" variant="ghost" loading={busy} onclick={() => void run('stop')}>Stop</Button
      >
    {:else}
      <Button size="sm" variant="primary" loading={busy} onclick={() => void run('start')}
        >Start</Button
      >
    {/if}
  </div>
</article>

{#if removing}
  <ConfirmDialog
    title={`Remove ${instance.label}?`}
    message={remote
      ? `The instance is removed from apm. Its base directory stays on ${app.targetLabel(instance.targetId)}.`
      : 'The instance is removed from apm and its base directory is deleted from this machine.'}
    confirmLabel="Remove"
    busy={removeBusy}
    onconfirm={() => void remove()}
    oncancel={() => (removing = false)}
  />
{/if}

<style>
  .card {
    display: flex;
    flex-direction: column;
    padding: 14px;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    transition: border-color 120ms ease;
  }

  .card:hover {
    border-color: var(--border-hover);
  }

  .head {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .name {
    font-size: 13px;
    font-weight: 600;
  }

  .rows {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 14px 0 0;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 12px;
    min-width: 0;
  }

  dt {
    width: 64px;
    flex: none;
    color: var(--muted-fg);
  }

  dd {
    margin: 0;
    min-width: 0;
  }

  .profiles {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .inline {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }

  .hint {
    margin-top: 12px;
    font-size: 11px;
    color: var(--muted-fg);
  }

  .reason {
    margin-top: 12px;
    font-size: 12px;
    color: color-mix(in oklab, var(--destructive) 82%, var(--tint-contrast));
  }

  .foot {
    display: flex;
    align-items: center;
    gap: 8px;
    /* auto keeps footers aligned across a row of unequal cards */
    margin-top: auto;
    padding-top: 12px;
    border-top: 1px solid var(--border);
  }

  .rows,
  .hint,
  .reason {
    margin-bottom: 16px;
  }
</style>
