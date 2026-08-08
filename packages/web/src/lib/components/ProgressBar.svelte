<script lang="ts">
  interface Props {
    /** 0..100 — the share of the window still available. */
    value: number;
    tone?: 'success' | 'warning' | 'destructive' | 'muted';
    label?: string;
  }

  let { value, tone = 'success', label }: Props = $props();

  const clamped = $derived(Math.max(0, Math.min(100, value)));
</script>

<div
  class="track"
  role="progressbar"
  aria-label={label ?? 'remaining'}
  aria-valuemin={0}
  aria-valuemax={100}
  aria-valuenow={Math.round(clamped)}
>
  <div class="fill {tone}" style="width: {clamped}%"></div>
</div>

<style>
  .track {
    flex: 1;
    height: 6px;
    min-width: 0;
    border-radius: 999px;
    background: var(--input);
    overflow: hidden;
  }

  .fill {
    height: 100%;
    border-radius: 999px;
    transition: width 240ms ease;
  }

  .success {
    background: var(--success);
  }

  .warning {
    background: var(--warning);
  }

  .destructive {
    background: var(--destructive);
  }

  .muted {
    background: var(--track);
  }
</style>
