<script lang="ts">
  import type { ProviderId } from '@apm/shared';
  import { app } from '../stores.svelte';

  interface Props {
    provider: ProviderId;
  }

  let { provider }: Props = $props();

  const INITIALS: Record<ProviderId, string> = { claude: 'A', codex: 'C', cursor: '▸' };

  const label = $derived(app.providerLabel(provider));
  const initial = $derived(INITIALS[provider]);
</script>

<span
  class="mark"
  style="--pcolor: var(--provider-{provider}, var(--dot-muted))"
  title={label}
  aria-hidden="true">{initial}</span
>

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
    background: var(--pcolor);
  }
</style>
