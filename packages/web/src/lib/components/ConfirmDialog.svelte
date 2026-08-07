<script lang="ts">
  import type { Snippet } from 'svelte';
  import Button from './Button.svelte';
  import Modal from './Modal.svelte';

  interface Props {
    title: string;
    message?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    variant?: 'primary' | 'destructive';
    busy?: boolean;
    onconfirm: () => void;
    oncancel: () => void;
    /** Extra controls (e.g. a purge checkbox) between message and buttons. */
    extra?: Snippet;
  }

  let {
    title,
    message,
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    variant = 'destructive',
    busy = false,
    onconfirm,
    oncancel,
    extra,
  }: Props = $props();
</script>

<Modal {title} width={400} onclose={oncancel}>
  {#if message}<p class="message">{message}</p>{/if}
  {#if extra}
    <div class="extra">{@render extra()}</div>
  {/if}

  {#snippet footer()}
    <Button variant="ghost" onclick={oncancel}>{cancelLabel}</Button>
    <Button {variant} loading={busy} onclick={onconfirm}>{confirmLabel}</Button>
  {/snippet}
</Modal>

<style>
  .message {
    font-size: 13px;
    color: var(--muted-fg);
  }

  .extra {
    margin-top: 14px;
  }
</style>
