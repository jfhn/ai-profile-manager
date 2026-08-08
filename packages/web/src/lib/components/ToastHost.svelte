<script lang="ts">
  import { toasts } from '../toasts.svelte';
  import IconButton from './IconButton.svelte';
</script>

<div class="host" aria-live="polite" aria-atomic="false">
  {#each toasts.items as item (item.id)}
    <div class="toast {item.variant}" role="status">
      <div class="text">
        <p class="title">{item.title}</p>
        {#if item.description}<p class="description">{item.description}</p>{/if}
      </div>
      <IconButton icon="close" label="Dismiss" size={14} onclick={() => toasts.dismiss(item.id)} />
    </div>
  {/each}
</div>

<style>
  .host {
    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: 200;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 8px;
    pointer-events: none;
  }

  .toast {
    pointer-events: auto;
    display: flex;
    align-items: flex-start;
    gap: 10px;
    width: 320px;
    padding: 10px 10px 10px 12px;
    background: var(--popover);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    box-shadow: var(--shadow-toast);
    animation: slide 140ms ease;
  }

  .toast.destructive {
    border-color: color-mix(in oklab, var(--destructive) 34%, transparent);
    background: color-mix(in oklab, var(--destructive) 9%, var(--popover));
  }

  .text {
    flex: 1;
    min-width: 0;
  }

  .title {
    font-size: 13px;
    font-weight: 500;
  }

  .toast.destructive .title {
    color: color-mix(in oklab, var(--destructive) 82%, var(--tint-contrast));
  }

  .description {
    margin-top: 2px;
    font-size: 12px;
    color: var(--muted-fg);
    overflow-wrap: anywhere;
  }

  @keyframes slide {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
  }
</style>
