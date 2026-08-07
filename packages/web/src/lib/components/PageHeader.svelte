<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    title: string;
    subtitle?: string;
    actions?: Snippet;
  }

  let { title, subtitle, actions }: Props = $props();
</script>

<header>
  <div class="titles">
    <h1 class="page-title">{title}</h1>
    {#if subtitle}<p class="subtitle">{subtitle}</p>{/if}
  </div>
  {#if actions}
    <div class="actions">{@render actions()}</div>
  {/if}
</header>

<style>
  header {
    display: flex;
    align-items: center;
    gap: 16px;
    min-height: 32px;
    margin-bottom: 24px;
  }

  .titles {
    flex: 1;
    min-width: 0;
  }

  .subtitle {
    margin-top: 2px;
    font-size: 12px;
    color: var(--muted-fg);
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }
</style>
