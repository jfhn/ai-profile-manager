/**
 * One shared clock for every relative timestamp in the app. Components read
 * these helpers inside markup/$derived, so a single 30s tick re-renders all
 * "3m ago" / "resets in 2h 14m" labels at once.
 */

const clock = $state({ now: Date.now() });

if (typeof window !== 'undefined') {
  setInterval(() => {
    clock.now = Date.now();
  }, 30_000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) clock.now = Date.now();
  });
}

/** Reactive current time in ms. */
export function now(): number {
  return clock.now;
}

function parse(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

function compact(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return '<1m';
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours > 0 ? `${days}d ${restHours}h` : `${days}d`;
}

/** "just now" · "3m ago" · "2h 5m ago" */
export function timeAgo(iso: string | null | undefined): string {
  const ms = parse(iso);
  if (ms === null) return 'unknown';
  const delta = clock.now - ms;
  if (delta < 45_000) return 'just now';
  if (delta < 0) return 'just now';
  return `${compact(delta)} ago`;
}

/** Time left until an ISO instant, or null when it has passed. */
export function timeUntil(iso: string | null | undefined): string | null {
  const ms = parse(iso);
  if (ms === null) return null;
  const delta = ms - clock.now;
  if (delta <= 0) return null;
  return compact(delta);
}

/** Time left on a countdown anchored at `iso` plus `seconds`. */
export function timeUntilFrom(
  iso: string | null | undefined,
  seconds: number | null,
): string | null {
  const ms = parse(iso);
  if (ms === null || seconds === null) return null;
  const delta = ms + seconds * 1000 - clock.now;
  if (delta <= 0) return null;
  return compact(delta);
}

/** Absolute timestamp for title attributes. */
export function absolute(iso: string | null | undefined): string {
  const ms = parse(iso);
  if (ms === null) return 'unknown';
  return new Date(ms).toLocaleString();
}
