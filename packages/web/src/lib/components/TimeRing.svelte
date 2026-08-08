<script lang="ts">
  /**
   * Small radial gauge for how much of a usage window's wall-clock time has
   * elapsed. Deliberately neutral in hue: it encodes time, not status — the
   * bar next to it carries the status color.
   */

  interface Props {
    /** 0..1 share of the window already elapsed, or null when unknown. */
    elapsed: number | null;
    size?: number;
    title?: string;
  }

  let { elapsed, size = 26, title }: Props = $props();

  const RADIUS = 11;
  const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

  const fraction = $derived(elapsed === null ? 0 : Math.max(0, Math.min(1, elapsed)));
  const offset = $derived(CIRCUMFERENCE * (1 - fraction));
</script>

<span class="ring" style="width: {size}px; height: {size}px" {title}>
  <svg viewBox="0 0 26 26" aria-hidden="true">
    <circle class="r-track" cx="13" cy="13" r={RADIUS}></circle>
    <circle
      class="r-arc"
      cx="13"
      cy="13"
      r={RADIUS}
      stroke-dasharray={CIRCUMFERENCE.toFixed(1)}
      stroke-dashoffset={offset.toFixed(1)}
    ></circle>
  </svg>
</span>

<style>
  .ring {
    position: relative;
    display: block;
    flex: none;
  }

  svg {
    width: 100%;
    height: 100%;
    transform: rotate(-90deg);
  }

  circle {
    fill: none;
    stroke-width: 3;
    stroke-linecap: round;
  }

  .r-track {
    stroke: var(--track);
    opacity: 0.45;
  }

  .r-arc {
    stroke: color-mix(in oklab, var(--muted-fg) 85%, var(--tint-contrast));
    /* app.css neutralises this under prefers-reduced-motion. */
    transition: stroke-dashoffset 240ms ease;
  }
</style>
