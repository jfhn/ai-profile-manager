<script lang="ts">
  import type { TerminalSession } from '@apm/shared';
  import Terminal from '../Terminal.svelte';
  import { app } from '../stores.svelte';
  import Badge from './Badge.svelte';
  import Button from './Button.svelte';
  import ProviderBadge from './ProviderBadge.svelte';

  interface Props {
    session: TerminalSession;
    onkill: (session: TerminalSession) => void;
  }

  let { session, onkill }: Props = $props();

  const profile = $derived(app.profile(session.profileId));
</script>

<section class="pane">
  <header>
    <h2 class="name truncate" title={session.name}>{session.name}</h2>
    {#if profile}
      <ProviderBadge provider={profile.provider} />
      <Badge title="Profile bound at spawn time">{profile.label}</Badge>
    {/if}
    <span class="cwd mono truncate" title={session.cwd}>{session.cwd}</span>
    <div class="spacer"></div>
    {#if session.status === 'running'}
      <Button variant="ghost" size="sm" onclick={() => onkill(session)}>Kill</Button>
    {/if}
  </header>

  {#key session.id}
    <Terminal sessionId={session.id} />
  {/key}
</section>

<style>
  .pane {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    min-height: 0;
  }

  header {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 32px;
    margin-bottom: 12px;
  }

  .name {
    font-size: 13px;
    font-weight: 600;
    max-width: 30%;
  }

  .cwd {
    color: var(--muted-fg);
    max-width: 40%;
  }

  header :global(.btn.ghost:hover) {
    color: var(--destructive);
    background: color-mix(in oklab, var(--destructive) 12%, transparent);
  }
</style>
