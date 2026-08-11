<script lang="ts">
  import type { Snippet } from 'svelte';
  import Spinner from './Spinner.svelte';

  interface Props {
    variant?: 'primary' | 'secondary' | 'ghost' | 'destructive';
    size?: 'sm' | 'md';
    disabled?: boolean;
    loading?: boolean;
    full?: boolean;
    title?: string;
    href?: string;
    target?: string;
    rel?: string;
    onclick?: (event: MouseEvent) => void;
    children: Snippet;
  }

  let {
    variant = 'secondary',
    size = 'md',
    disabled = false,
    loading = false,
    full = false,
    title,
    href,
    target,
    rel,
    onclick,
    children,
  }: Props = $props();
</script>

{#if href}
  <a class="btn {variant} {size}" class:full {href} {target} {rel} {title}>
    {@render children()}
  </a>
{:else}
  <button
    class="btn {variant} {size}"
    class:full
    type="button"
    {title}
    disabled={disabled || loading}
    {onclick}
  >
    {#if loading}<Spinner size={12} />{/if}
    {@render children()}
  </button>
{/if}

<style>
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    white-space: nowrap;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    font-weight: 500;
    transition:
      background 120ms ease,
      border-color 120ms ease,
      color 120ms ease,
      opacity 120ms ease;
  }

  .md {
    height: 32px;
    padding: 0 12px;
    font-size: 13px;
  }

  .sm {
    height: 26px;
    padding: 0 10px;
    font-size: 12px;
  }

  .full {
    width: 100%;
  }

  .primary {
    background: var(--primary);
    color: var(--primary-fg);
  }

  .primary:hover:not(:disabled) {
    background: color-mix(in oklab, var(--primary) 88%, var(--tint-contrast));
  }

  .secondary {
    background: var(--fill-5);
    border-color: var(--input);
    color: var(--fg);
  }

  .secondary:hover:not(:disabled) {
    background: var(--fill-9);
  }

  .ghost {
    color: var(--muted-fg);
  }

  .ghost:hover:not(:disabled) {
    background: var(--hover);
    color: var(--fg);
  }

  .destructive {
    color: var(--destructive);
    border-color: color-mix(in oklab, var(--destructive) 28%, transparent);
    background: color-mix(in oklab, var(--destructive) 10%, transparent);
  }

  .destructive:hover:not(:disabled) {
    background: color-mix(in oklab, var(--destructive) 18%, transparent);
  }

  .btn:disabled {
    opacity: 0.45;
  }
</style>
