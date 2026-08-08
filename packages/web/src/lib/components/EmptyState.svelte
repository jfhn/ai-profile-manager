<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from './Icon.svelte';
  import type { IconName } from './Icon.svelte';

  interface Props {
    title: string;
    description?: string;
    icon?: IconName;
    /** Dashed hero treatment for the "nothing here yet" case. */
    dashed?: boolean;
    action?: Snippet;
  }

  let { title, description, icon, dashed = false, action }: Props = $props();
</script>

<div class="empty" class:dashed>
  {#if icon}
    <span class="icon"><Icon name={icon} size={18} /></span>
  {/if}
  <h3 class="section-title">{title}</h3>
  {#if description}<p class="description">{description}</p>{/if}
  {#if action}
    <div class="action">{@render action()}</div>
  {/if}
</div>

<style>
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 48px 24px;
    text-align: center;
    border-radius: var(--radius);
  }

  .dashed {
    border: 1px dashed var(--border-dashed);
    background: color-mix(in oklab, var(--card) 55%, transparent);
  }

  .icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    margin-bottom: 4px;
    border-radius: var(--radius-sm);
    background: var(--fill-5);
    color: var(--muted-fg);
  }

  .description {
    max-width: 380px;
    font-size: 12px;
    color: var(--muted-fg);
  }

  .action {
    margin-top: 8px;
  }
</style>
