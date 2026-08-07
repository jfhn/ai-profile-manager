<script lang="ts">
  interface Props {
    tone: 'success' | 'muted' | 'warning' | 'destructive';
    pulse?: boolean;
    size?: number;
    title?: string;
  }

  let { tone, pulse = false, size = 7, title }: Props = $props();
</script>

<span
  class="dot {tone}"
  class:pulse
  style="width: {size}px; height: {size}px"
  {title}
  aria-hidden="true"
></span>

<style>
  .dot {
    display: inline-block;
    flex: none;
    border-radius: 999px;
  }

  .success {
    background: var(--success);
    box-shadow: 0 0 0 3px color-mix(in oklab, var(--success) 16%, transparent);
  }

  .warning {
    background: var(--warning);
    box-shadow: 0 0 0 3px color-mix(in oklab, var(--warning) 16%, transparent);
  }

  .destructive {
    background: var(--destructive);
    box-shadow: 0 0 0 3px color-mix(in oklab, var(--destructive) 16%, transparent);
  }

  .muted {
    background: #5a5a5e;
  }

  .pulse {
    animation: apm-pulse 1.6s ease-in-out infinite;
  }
</style>
