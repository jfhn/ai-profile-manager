<script lang="ts">
  import type { TerminalSession } from '@apm/shared';
  import { api } from '../lib/api';
  import { app } from '../lib/stores.svelte';
  import { toast, toastError } from '../lib/toasts.svelte';
  import Button from '../lib/components/Button.svelte';
  import ConfirmDialog from '../lib/components/ConfirmDialog.svelte';
  import EmptyState from '../lib/components/EmptyState.svelte';
  import Icon from '../lib/components/Icon.svelte';
  import NewSessionModal from '../lib/components/NewSessionModal.svelte';
  import PageHeader from '../lib/components/PageHeader.svelte';
  import SessionList from '../lib/components/SessionList.svelte';
  import TerminalPane from '../lib/components/TerminalPane.svelte';

  let selectedId = $state<string | null>(null);
  let creating = $state(false);
  let killTarget = $state<TerminalSession | null>(null);
  let killBusy = $state(false);

  const sessions = $derived(
    [...app.sessions].sort((a, b) => {
      if (a.status !== b.status) return a.status === 'running' ? -1 : 1;
      return b.createdAt.localeCompare(a.createdAt);
    }),
  );

  // selectedId is only a preference — the visible session always comes from the
  // live list, so a disposed session falls back to the first one automatically.
  const selected = $derived(
    sessions.find((session) => session.id === selectedId) ?? sessions[0] ?? null,
  );

  const running = $derived(sessions.filter((session) => session.status === 'running').length);

  async function reload(): Promise<void> {
    try {
      app.sessions = await api.sessions();
    } catch {
      // The SSE stream will re-sync; a failed refresh is not worth a toast.
    }
  }

  async function dispose(session: TerminalSession): Promise<void> {
    try {
      await api.deleteSession(session.id);
      await reload();
    } catch (error) {
      toastError(error, 'Could not remove the session');
    }
  }

  async function confirmKill(): Promise<void> {
    const target = killTarget;
    if (!target) return;
    killBusy = true;
    try {
      await api.deleteSession(target.id);
      killTarget = null;
      await reload();
      toast('Session killed', target.name);
    } catch (error) {
      toastError(error, 'Could not kill the session');
    } finally {
      killBusy = false;
    }
  }
</script>

<div class="page">
  <PageHeader
    title="Sessions"
    subtitle={sessions.length === 0
      ? 'Provider CLIs running in a PTY owned by the daemon'
      : `${running} running · ${sessions.length} total`}
  />

  <div class="panes">
    {#if sessions.length === 0}
      <EmptyState
        title="No sessions yet"
        description="Start claude, codex or any command with a profile's environment. Sessions outlive this tab — closing it only detaches."
        icon="terminal"
        dashed
      >
        {#snippet action()}
          <Button variant="primary" onclick={() => (creating = true)}>
            <Icon name="plus" size={14} />
            New session
          </Button>
        {/snippet}
      </EmptyState>
    {:else}
      <SessionList
        {sessions}
        selectedId={selected?.id ?? null}
        onselect={(id) => (selectedId = id)}
        ondispose={(session) => void dispose(session)}
        onnew={() => (creating = true)}
      />
      <div class="divider"></div>
      {#if selected}
        <TerminalPane session={selected} onkill={(session) => (killTarget = session)} />
      {/if}
    {/if}
  </div>
</div>

{#if creating}
  <NewSessionModal
    onclose={() => (creating = false)}
    oncreated={(session) => {
      selectedId = session.id;
      void reload();
    }}
  />
{/if}

{#if killTarget}
  <ConfirmDialog
    title={`Kill ${killTarget.name}?`}
    message="The process and everything it started are terminated. Unsaved work in the TUI is lost."
    confirmLabel="Kill session"
    busy={killBusy}
    onconfirm={() => void confirmKill()}
    oncancel={() => (killTarget = null)}
  />
{/if}

<style>
  .page {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    width: 100%;
    max-width: 1200px;
    margin-inline: auto;
    padding: 24px;
  }

  .panes {
    display: flex;
    flex: 1;
    min-height: 0;
    gap: 16px;
  }

  .divider {
    width: 1px;
    flex: none;
    background: var(--border);
  }

  .panes > :global(.empty) {
    flex: 1;
    align-self: center;
  }
</style>
