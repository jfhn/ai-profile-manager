<script module lang="ts">
  /** Hand-drawn 16px stroke icons — no icon dependency. */
  export type IconName =
    | 'dashboard'
    | 'terminal'
    | 'layers'
    | 'refresh'
    | 'kebab'
    | 'plus'
    | 'close'
    | 'check'
    | 'copy'
    | 'play'
    | 'stop'
    | 'external'
    | 'trash'
    | 'alert'
    | 'folder'
    | 'sparkle';
</script>

<script lang="ts">
  interface Props {
    name: IconName;
    size?: number;
    strokeWidth?: number;
    class?: string;
  }

  let { name, size = 16, strokeWidth = 1.5, class: className = '' }: Props = $props();
</script>

<svg
  class={className}
  width={size}
  height={size}
  viewBox="0 0 16 16"
  fill="none"
  stroke="currentColor"
  stroke-width={strokeWidth}
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  focusable="false"
>
  {#if name === 'dashboard'}
    <rect x="2" y="2" width="5" height="5" rx="1.4" />
    <rect x="9" y="2" width="5" height="5" rx="1.4" />
    <rect x="2" y="9" width="5" height="5" rx="1.4" />
    <rect x="9" y="9" width="5" height="5" rx="1.4" />
  {:else if name === 'terminal'}
    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
    <path d="M4.75 6.75 6.5 8.25 4.75 9.75" />
    <path d="M8.5 10.25h2.75" />
  {:else if name === 'layers'}
    <path d="M8 1.9 14 5.1 8 8.3 2 5.1z" />
    <path d="M2.4 8.1 8 11.1l5.6-3" />
    <path d="M2.4 10.9 8 13.9l5.6-3" />
  {:else if name === 'refresh'}
    <path d="M13.4 8a5.4 5.4 0 1 1-1.72-3.95" />
    <path d="M13.6 2.3v3.1h-3.1" />
  {:else if name === 'kebab'}
    <circle cx="8" cy="3.3" r="1.05" fill="currentColor" stroke="none" />
    <circle cx="8" cy="8" r="1.05" fill="currentColor" stroke="none" />
    <circle cx="8" cy="12.7" r="1.05" fill="currentColor" stroke="none" />
  {:else if name === 'plus'}
    <path d="M8 3.2v9.6M3.2 8h9.6" />
  {:else if name === 'close'}
    <path d="M4 4l8 8M12 4l-8 8" />
  {:else if name === 'check'}
    <path d="M3.2 8.4 6.4 11.6 12.8 4.8" />
  {:else if name === 'copy'}
    <rect x="5.75" y="5.75" width="8.5" height="8.5" rx="1.8" />
    <path d="M10.5 5.5v-2A1.5 1.5 0 0 0 9 2H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5h2" />
  {:else if name === 'play'}
    <path d="M5.2 3.4 12.4 8l-7.2 4.6z" fill="currentColor" />
  {:else if name === 'stop'}
    <rect x="4.2" y="4.2" width="7.6" height="7.6" rx="1.6" fill="currentColor" stroke="none" />
  {:else if name === 'external'}
    <path
      d="M7.2 3H3.6A1.6 1.6 0 0 0 2 4.6v7.8A1.6 1.6 0 0 0 3.6 14h7.8a1.6 1.6 0 0 0 1.6-1.6V8.8"
    />
    <path d="M9.6 2.4H14v4.4" />
    <path d="M13.6 2.8 7.8 8.6" />
  {:else if name === 'trash'}
    <path d="M2.6 4.3h10.8" />
    <path d="M6.1 4.3V3.1A1.1 1.1 0 0 1 7.2 2h1.6a1.1 1.1 0 0 1 1.1 1.1v1.2" />
    <path d="M4 4.3l.62 8.15A1.4 1.4 0 0 0 6.02 13.8h3.96a1.4 1.4 0 0 0 1.4-1.35L12 4.3" />
  {:else if name === 'alert'}
    <path d="M8 2.6 14.3 13.3H1.7z" />
    <path d="M8 6.6v3.1" />
    <circle cx="8" cy="11.5" r="0.75" fill="currentColor" stroke="none" />
  {:else if name === 'folder'}
    <path
      d="M2 4.6A1.6 1.6 0 0 1 3.6 3h2.3l1.5 1.9h5A1.6 1.6 0 0 1 14 6.5v5.3a1.6 1.6 0 0 1-1.6 1.6H3.6A1.6 1.6 0 0 1 2 11.8z"
    />
  {:else if name === 'sparkle'}
    <path d="M8 2.2 9.4 6.2 13.4 7.6 9.4 9 8 13 6.6 9 2.6 7.6 6.6 6.2z" />
  {/if}
</svg>

<style>
  svg {
    display: block;
    flex: none;
  }
</style>
