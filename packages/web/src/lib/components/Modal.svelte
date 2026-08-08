<script lang="ts">
  import type { Snippet } from 'svelte';
  import IconButton from './IconButton.svelte';

  interface Props {
    title: string;
    subtitle?: string;
    width?: number;
    /** Called on Escape, backdrop click and the close button. */
    onclose: () => void;
    children: Snippet;
    footer?: Snippet;
  }

  let { title, subtitle, width = 460, onclose, children, footer }: Props = $props();

  let dialog = $state<HTMLDivElement | null>(null);

  const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function focusables(): HTMLElement[] {
    if (!dialog) return [];
    return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (element) => element.offsetParent !== null || element === document.activeElement,
    );
  }

  $effect(() => {
    const restoreTo = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Prefer the first real control; otherwise focus the dialog itself rather
    // than the close button, which would read as "the action here is cancel".
    const items = focusables();
    (items.find((item) => item.dataset['autofocus'] !== undefined) ?? dialog)?.focus();
    return () => {
      document.body.style.overflow = overflow;
      restoreTo?.focus?.();
    };
  });

  function onkeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onclose();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = focusables();
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) {
      event.preventDefault();
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
</script>

<div
  class="backdrop"
  role="presentation"
  onclick={(event) => {
    if (event.target === event.currentTarget) onclose();
  }}
>
  <div
    class="dialog"
    style="width: {width}px"
    role="dialog"
    aria-modal="true"
    aria-label={title}
    tabindex="-1"
    bind:this={dialog}
    {onkeydown}
  >
    <header>
      <div class="titles">
        <h2 class="section-title">{title}</h2>
        {#if subtitle}<p class="subtitle">{subtitle}</p>{/if}
      </div>
      <IconButton icon="close" label="Close dialog" onclick={onclose} />
    </header>

    <div class="body">
      {@render children()}
    </div>

    {#if footer}
      <footer>
        {@render footer()}
      </footer>
    {/if}
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: var(--scrim);
    backdrop-filter: blur(2px);
    animation: fade 120ms ease;
  }

  /* The dialog is focused programmatically on open; a ring around the whole
     panel would be noise. Real controls keep their own focus styles. */
  .dialog:focus-visible {
    outline: none;
  }

  .dialog {
    max-width: 100%;
    max-height: calc(100vh - 48px);
    display: flex;
    flex-direction: column;
    background: var(--popover);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow:
      0 1px 0 var(--surface-highlight) inset,
      var(--shadow-modal);
    animation: pop 120ms ease;
  }

  header {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 16px 16px 12px;
  }

  .titles {
    flex: 1;
    min-width: 0;
  }

  .subtitle {
    margin-top: 2px;
    font-size: 12px;
    color: var(--muted-fg);
  }

  .body {
    padding: 0 16px 16px;
    overflow-y: auto;
  }

  footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 16px;
    border-top: 1px solid var(--border);
  }

  @keyframes fade {
    from {
      opacity: 0;
    }
  }

  @keyframes pop {
    from {
      opacity: 0;
      transform: translateY(6px) scale(0.985);
    }
  }
</style>
