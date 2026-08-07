<script lang="ts">
  import type { TerminalSession } from '@apm/shared';
  import { app } from '../stores.svelte';
  import Button from './Button.svelte';
  import Icon from './Icon.svelte';
  import StatusDot from './StatusDot.svelte';

  interface Props {
    sessions: TerminalSession[];
    selectedId: string | null;
    onselect: (id: string) => void;
    ondispose: (session: TerminalSession) => void;
    onnew: () => void;
  }

  let { sessions, selectedId, onselect, ondispose, onnew }: Props = $props();

  function meta(session: TerminalSession): string {
    const parts = [app.profileLabel(session.profileId), session.app];
    if (session.status === 'running') {
      parts.push(
        session.attachedClients === 1 ? '1 attached' : `${session.attachedClients} attached`,
      );
    } else if (session.exitCode !== null) {
      parts.push(`exit ${session.exitCode}`);
    }
    return parts.join(' · ');
  }
</script>

<div class="list">
  <div class="top">
    <Button variant="primary" full onclick={onnew}>
      <Icon name="plus" size={14} />
      New session
    </Button>
  </div>

  <div class="rows">
    {#each sessions as session (session.id)}
      <div class="row" class:selected={session.id === selectedId}>
        <button class="main" type="button" onclick={() => onselect(session.id)}>
          <StatusDot tone={session.status === 'running' ? 'success' : 'muted'} size={6} />
          <span class="text">
            <span class="name truncate">{session.name}</span>
            <span class="meta truncate">{meta(session)}</span>
          </span>
        </button>
        {#if session.status === 'exited'}
          <button
            class="dispose"
            type="button"
            aria-label={`Remove ${session.name}`}
            title="Remove from the list"
            onclick={() => ondispose(session)}
          >
            <Icon name="close" size={13} />
          </button>
        {/if}
      </div>
    {/each}
  </div>
</div>

<style>
  .list {
    display: flex;
    flex-direction: column;
    width: 280px;
    flex: none;
    min-height: 0;
  }

  .top {
    padding-bottom: 12px;
  }

  .rows {
    display: flex;
    flex-direction: column;
    gap: 2px;
    overflow-y: auto;
    min-height: 0;
    padding-right: 2px;
  }

  .row {
    display: flex;
    align-items: center;
    border-radius: var(--radius-sm);
    transition: background 120ms ease;
  }

  .row:hover {
    background: var(--hover);
  }

  .row.selected {
    background: var(--hover);
  }

  .main {
    display: flex;
    align-items: center;
    gap: 9px;
    flex: 1;
    min-width: 0;
    padding: 8px 4px 8px 9px;
    text-align: left;
  }

  .text {
    display: flex;
    flex-direction: column;
    min-width: 0;
    line-height: 1.35;
  }

  .name {
    font-size: 13px;
    color: var(--muted-fg);
  }

  .row.selected .name {
    color: var(--fg);
  }

  .meta {
    font-size: 11px;
    color: var(--muted-fg);
  }

  .dispose {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    margin-right: 5px;
    flex: none;
    border-radius: 5px;
    color: var(--muted-fg);
    opacity: 0;
    transition:
      opacity 120ms ease,
      background 120ms ease,
      color 120ms ease;
  }

  .row:hover .dispose,
  .dispose:focus-visible {
    opacity: 1;
  }

  .dispose:hover {
    background: color-mix(in oklab, var(--destructive) 14%, transparent);
    color: var(--destructive);
  }
</style>
