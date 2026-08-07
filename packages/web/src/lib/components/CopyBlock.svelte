<script lang="ts">
  import Icon from './Icon.svelte';

  interface Props {
    value: string;
    label?: string;
  }

  let { value, label = 'Copy command' }: Props = $props();

  let copied = $state(false);
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const area = document.createElement('textarea');
      area.value = value;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    copied = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      copied = false;
    }, 1600);
  }

  $effect(() => () => {
    if (timer) clearTimeout(timer);
  });
</script>

<div class="block">
  <code class="code">{value}</code>
  <button class="copy" class:copied type="button" aria-label={label} title={label} onclick={copy}>
    <Icon name={copied ? 'check' : 'copy'} size={14} />
    <span>{copied ? 'Copied' : 'Copy'}</span>
  </button>
</div>

<style>
  .block {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 10px 10px 10px 12px;
    background: rgba(0, 0, 0, 0.28);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }

  .code {
    flex: 1;
    min-width: 0;
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.6;
    color: #e6e6e6;
    overflow-wrap: anywhere;
    user-select: all;
  }

  .copy {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    flex: none;
    height: 24px;
    padding: 0 8px;
    font-size: 11px;
    color: var(--muted-fg);
    border: 1px solid var(--input);
    border-radius: 5px;
    transition:
      background 120ms ease,
      color 120ms ease,
      border-color 120ms ease;
  }

  .copy:hover {
    background: var(--hover);
    color: var(--fg);
  }

  .copy.copied {
    color: color-mix(in oklab, var(--success) 78%, white);
    border-color: color-mix(in oklab, var(--success) 34%, transparent);
  }
</style>
