<script lang="ts">
  interface Props {
    size?: number;
  }

  let { size = 14 }: Props = $props();
</script>

<svg
  class="spinner"
  width={size}
  height={size}
  viewBox="0 0 16 16"
  fill="none"
  stroke="currentColor"
  stroke-width="1.8"
  stroke-linecap="round"
  aria-hidden="true"
>
  <circle cx="8" cy="8" r="6" opacity="0.22" />
  <path d="M14 8a6 6 0 0 0-6-6" />
</svg>

<style>
  .spinner {
    display: block;
    flex: none;
    animation: apm-spin 720ms linear infinite;
  }
</style>
