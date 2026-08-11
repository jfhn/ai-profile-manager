<script lang="ts">
  import type { ProviderId } from '@apm/shared';
  import { app } from '../stores.svelte';

  interface Props {
    provider: ProviderId;
  }

  let { provider }: Props = $props();

  const INITIALS: Record<string, string> = { claude: 'A', codex: 'C' };

  const label = $derived(app.providerLabel(provider));
  const initial = $derived(INITIALS[provider] ?? label.charAt(0).toUpperCase());
</script>

<span class="mark {provider}" title={label} aria-hidden="true">{initial}</span>

<style>
  .mark {
    display: grid;
    place-items: center;
    flex: none;
    width: 18px;
    height: 18px;
    border-radius: var(--radius-sm);
    font-size: 10px;
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
