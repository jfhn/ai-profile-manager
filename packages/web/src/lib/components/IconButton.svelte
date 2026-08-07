<script lang="ts">
  import Icon from './Icon.svelte';
  import type { IconName } from './Icon.svelte';

  interface Props {
    icon: IconName;
    label: string;
    size?: number;
    spinning?: boolean;
    disabled?: boolean;
    danger?: boolean;
    active?: boolean;
    onclick?: (event: MouseEvent) => void;
  }

  let {
    icon,
    label,
    size = 16,
    spinning = false,
    disabled = false,
    danger = false,
    active = false,
    onclick,
  }: Props = $props();
</script>

<button
  class="icon-btn"
  class:danger
  class:active
  type="button"
  aria-label={label}
  title={label}
  {disabled}
  {onclick}
>
  <span class="glyph" class:spinning>
    <Icon name={icon} {size} />
  </span>
</button>

<style>
  .icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border-radius: var(--radius-sm);
    color: var(--muted-fg);
    transition:
      background 120ms ease,
      color 120ms ease;
  }

  .icon-btn:hover:not(:disabled) {
    background: var(--hover);
    color: var(--fg);
  }

  .icon-btn.active {
    background: var(--hover);
    color: var(--fg);
  }

  .icon-btn.danger:hover:not(:disabled) {
    color: var(--destructive);
    background: color-mix(in oklab, var(--destructive) 12%, transparent);
  }

  .icon-btn:disabled {
    opacity: 0.4;
  }

  .glyph {
    display: block;
  }

  .glyph.spinning {
    animation: apm-spin 700ms linear infinite;
  }
</style>
