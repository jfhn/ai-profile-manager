<script lang="ts">
  import type { ProviderId } from '@apm/shared';
  import Badge from './Badge.svelte';
  import { app } from '../stores.svelte';

  interface Props {
    provider: ProviderId;
  }

  let { provider }: Props = $props();
  const label = $derived(app.providerLabel(provider));
</script>

<Badge tone={provider === 'claude' ? 'claude' : 'codex'}>{label}</Badge>
