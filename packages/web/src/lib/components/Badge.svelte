<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    tone?: 'neutral' | 'success' | 'warning' | 'destructive' | 'primary' | 'claude' | 'codex';
    title?: string;
    children: Snippet;
  }

  let { tone = 'neutral', title, children }: Props = $props();
</script>

<span class="badge {tone}" {title}>{@render children()}</span>

<style>
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 18px;
    padding: 0 7px;
    border-radius: 999px;
    border: 1px solid transparent;
    font-size: 11px;
    font-weight: 500;
    line-height: 1;
    white-space: nowrap;
  }

  .neutral {
    background: rgba(255, 255, 255, 0.06);
    color: var(--muted-fg);
  }

  .primary {
    background: color-mix(in oklab, var(--primary) 16%, transparent);
    color: color-mix(in oklab, var(--primary) 65%, white);
  }

  .success {
    background: color-mix(in oklab, var(--success) 14%, transparent);
    color: color-mix(in oklab, var(--success) 78%, white);
  }

  .warning {
    background: color-mix(in oklab, var(--warning) 14%, transparent);
    color: color-mix(in oklab, var(--warning) 78%, white);
  }

  .destructive {
    background: color-mix(in oklab, var(--destructive) 14%, transparent);
    color: color-mix(in oklab, var(--destructive) 82%, white);
  }

  .claude {
    background: color-mix(in oklab, var(--claude) 16%, transparent);
    color: color-mix(in oklab, var(--claude) 80%, white);
  }

  .codex {
    background: rgba(255, 255, 255, 0.1);
    color: #e8e8ea;
  }
</style>
