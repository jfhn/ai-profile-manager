<script lang="ts">
  import type { ProviderId } from '@apm/shared';
  import { app } from '../stores.svelte';

  interface Props {
    provider: ProviderId;
    size?: number;
  }

  let { provider, size = 18 }: Props = $props();

  const INITIALS: Record<string, string> = { claude: 'A', codex: 'C' };

  const label = $derived(app.providerLabel(provider));
  const initial = $derived(INITIALS[provider] ?? label.charAt(0).toUpperCase());
</script>

<span
  class="mark {provider}"
  style="width: {size}px; height: {size}px; font-size: {Math.round(size * 0.55)}px"
  title={label}
  aria-hidden="true">{initial}</span
>

<style>
  .mark {
    display: grid;
    place-items: center;
    flex: none;
    border-radius: var(--radius-sm);
    font-weight: 700;
    line-height: 1;
    color: #ffffff;
    background: var(--dot-muted);
  }

  .claude {
    background: var(--claude);
  }

  .codex {
    background: var(--codex);
  }
</style>
