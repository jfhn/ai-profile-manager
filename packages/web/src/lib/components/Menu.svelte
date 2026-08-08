<script module lang="ts">
  export interface MenuItem {
    label: string;
    onSelect: () => void;
    danger?: boolean;
    disabled?: boolean;
  }
</script>

<script lang="ts">
  import IconButton from './IconButton.svelte';

  interface Props {
    items: MenuItem[];
    label?: string;
  }

  let { items, label = 'More actions' }: Props = $props();

  let open = $state(false);
  let root = $state<HTMLDivElement | null>(null);

  $effect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (root && !root.contains(event.target as Node)) open = false;
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') open = false;
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKey);
    };
  });

  function select(item: MenuItem): void {
    open = false;
    item.onSelect();
  }
</script>

<div class="menu" bind:this={root}>
  <IconButton
    icon="kebab"
    {label}
    active={open}
    onclick={() => {
      open = !open;
    }}
  />
  {#if open}
    <div class="popover" role="menu" tabindex="-1">
      {#each items as item (item.label)}
        <button
          class="item"
          class:danger={item.danger}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          onclick={() => select(item)}
        >
          {item.label}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .menu {
    position: relative;
    display: inline-flex;
  }

  .popover {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 50;
    min-width: 168px;
    padding: 4px;
    background: var(--popover);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    box-shadow: var(--shadow-menu);
    animation: pop 120ms ease;
  }

  .item {
    display: block;
    width: 100%;
    padding: 6px 8px;
    text-align: left;
    font-size: 12px;
    color: var(--fg);
    border-radius: 5px;
    transition:
      background 120ms ease,
      color 120ms ease;
  }

  .item:hover:not(:disabled) {
    background: var(--hover);
  }

  .item.danger {
    color: var(--destructive);
  }

  .item.danger:hover:not(:disabled) {
    background: color-mix(in oklab, var(--destructive) 12%, transparent);
  }

  .item:disabled {
    opacity: 0.4;
  }

  @keyframes pop {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }
  }
</style>
