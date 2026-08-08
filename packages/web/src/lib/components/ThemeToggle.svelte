<script lang="ts">
  import Icon from './Icon.svelte';
  import type { IconName } from './Icon.svelte';
  import { theme } from '../theme.svelte';
  import type { ThemePreference } from '../theme';

  interface Option {
    value: ThemePreference;
    label: string;
    icon: IconName;
  }

  const options: Option[] = [
    { value: 'system', label: 'System', icon: 'monitor' },
    { value: 'light', label: 'Light', icon: 'sun' },
    { value: 'dark', label: 'Dark', icon: 'moon' },
  ];
</script>

<div class="segmented" role="group" aria-label="Color theme">
  {#each options as option (option.value)}
    <button
      class="segment"
      class:active={theme.preference === option.value}
      type="button"
      title={option.value === 'system' ? 'Match the system theme' : `${option.label} theme`}
      aria-label={option.label}
      aria-pressed={theme.preference === option.value}
      onclick={() => theme.select(option.value)}
    >
      <Icon name={option.icon} size={14} />
    </button>
  {/each}
</div>

<style>
  .segmented {
    display: flex;
    padding: 2px;
    background: var(--fill-4);
    border: 1px solid var(--border);
    border-radius: 8px;
  }

  .segment {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    height: 22px;
    border-radius: var(--radius-sm);
    color: var(--muted-fg);
    transition:
      background 120ms ease,
      color 120ms ease;
  }

  .segment:hover {
    color: var(--fg);
  }

  .segment.active {
    background: var(--fill-8);
    color: var(--fg);
  }
</style>
