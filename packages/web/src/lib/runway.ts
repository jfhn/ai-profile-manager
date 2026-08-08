/**
 * Derivations behind the "Runway" dashboard: per-window views, burn-pace
 * scoring, provider grouping and the verdict/stat-tile roll-ups.
 *
 * Everything here is pure and framework-free so it can be unit tested; the
 * Svelte side only feeds it `app.profiles`, `app.usage` and the shared clock.
 */

import type { Profile, ProviderId, UsageSnapshot, UsageWindow } from '@apm/shared';

export type Tone = 'success' | 'warning' | 'destructive';
export type WindowTone = Tone | 'muted';

/** Existing dashboard thresholds — kept identical so nothing shifts hue. */
export function toneOf(remaining: number): Tone {
  if (remaining >= 50) return 'success';
  if (remaining >= 20) return 'warning';
  return 'destructive';
}

const HOUR = 3_600_000;

/**
 * Providers report a reset instant but never the window start, so the length
 * is inferred from the window id. Ids we don't know keep an unknown length and
 * fall back to the reset-distance heuristic below.
 */
export const WINDOW_DURATION_MS: Record<string, number> = {
  five_hour: 5 * HOUR,
  weekly: 7 * 24 * HOUR,
  fable_weekly: 7 * 24 * HOUR,
  monthly: 30 * 24 * HOUR,
};

/** Display labels for the redesign; adapter labels are the fallback. */
const WINDOW_LABELS: Record<string, string> = {
  five_hour: '5h',
  weekly: 'Weekly',
  fable_weekly: 'Weekly · Fable 5',
  monthly: 'Monthly',
};

const WINDOW_ORDER = ['five_hour', 'weekly', 'fable_weekly', 'monthly'];

export function windowLabel(window: UsageWindow): string {
  return WINDOW_LABELS[window.id] ?? window.label;
}

export function remainingOf(window: UsageWindow): number | null {
  if (window.remainingPercent !== null) return window.remainingPercent;
  if (window.usedPercent !== null) return 100 - window.usedPercent;
  return null;
}

export interface WindowView {
  id: string;
  label: string;
  /** 0..100, or null when the provider did not report the window. */
  remaining: number | null;
  tone: WindowTone;
  resetAt: string | null;
  resetAtMs: number | null;
  /** Share of the window's wall-clock time already spent (0..1), if derivable. */
  elapsedFraction: number | null;
  /** Higher means "burning through this window faster"; null when unscorable. */
  burn: number | null;
}

export function windowView(window: UsageWindow, nowMs: number): WindowView {
  const remaining = remainingOf(window);
  const parsed = window.resetAt ? Date.parse(window.resetAt) : Number.NaN;
  const resetAtMs = Number.isFinite(parsed) ? parsed : null;
  const duration = WINDOW_DURATION_MS[window.id] ?? null;

  let elapsedFraction: number | null = null;
  if (resetAtMs !== null && duration) {
    const startMs = resetAtMs - duration;
    elapsedFraction = Math.min(1, Math.max(0, (nowMs - startMs) / duration));
  }

  return {
    id: window.id,
    label: windowLabel(window),
    remaining,
    tone: remaining === null ? 'muted' : toneOf(remaining),
    resetAt: window.resetAt,
    resetAtMs,
    elapsedFraction,
    burn: burnPace(remaining, elapsedFraction, resetAtMs, nowMs),
  };
}

/**
 * Burn pace for one window. When the window start is derivable we score
 * consumption against elapsed time: spending 60% of a quota one quarter into
 * the window scores 240. When it is not, we fall back to the spec'd
 * remaining-per-hour ratio, which stays on its own scale but still gives a
 * deterministic tiebreak between otherwise equal profiles.
 */
export function burnPace(
  remaining: number | null,
  elapsedFraction: number | null,
  resetAtMs: number | null,
  nowMs: number,
): number | null {
  if (remaining === null) return null;
  if (elapsedFraction !== null && elapsedFraction > 0) {
    return (100 - remaining) / elapsedFraction;
  }
  if (resetAtMs !== null && resetAtMs > nowMs) {
    return remaining / ((resetAtMs - nowMs) / HOUR);
  }
  return null;
}

export interface ProfileView {
  profile: Profile;
  snapshot: UsageSnapshot | undefined;
  windows: WindowView[];
  /** The window with the least left — what the profile's state hangs on. */
  tightest: WindowView | null;
  /** 0..100 of the tightest window, or null when nothing is reported. */
  headroom: number | null;
  tone: WindowTone;
  /** Worst (highest) burn pace across reported windows. */
  burn: number;
  /** Soonest future reset across reported windows. */
  nextResetMs: number | null;
  nextResetWindow: WindowView | null;
}

export function profileView(
  profile: Profile,
  snapshot: UsageSnapshot | undefined,
  nowMs: number,
): ProfileView {
  const windows = [...(snapshot?.windows ?? [])]
    .sort((a, b) => orderIndex(a.id) - orderIndex(b.id))
    .map((window) => windowView(window, nowMs));

  let tightest: WindowView | null = null;
  let burn = 0;
  let nextResetWindow: WindowView | null = null;

  for (const window of windows) {
    if (
      window.remaining !== null &&
      (tightest === null || window.remaining < tightest.remaining!)
    ) {
      tightest = window;
    }
    if (window.burn !== null && window.burn > burn) burn = window.burn;
    if (
      window.resetAtMs !== null &&
      window.resetAtMs > nowMs &&
      (nextResetWindow === null || window.resetAtMs < nextResetWindow.resetAtMs!)
    ) {
      nextResetWindow = window;
    }
  }

  return {
    profile,
    snapshot,
    windows,
    tightest,
    headroom: tightest?.remaining ?? null,
    tone: tightest === null ? 'muted' : tightest.tone,
    burn,
    nextResetMs: nextResetWindow?.resetAtMs ?? null,
    nextResetWindow,
  };
}

function orderIndex(id: string): number {
  const index = WINDOW_ORDER.indexOf(id);
  return index === -1 ? WINDOW_ORDER.length : index;
}

/** destructive first, then warning, then healthy/unknown. */
export function statusTier(tone: WindowTone): number {
  if (tone === 'destructive') return 0;
  if (tone === 'warning') return 1;
  return 2;
}

/**
 * Urgency comparator: status tier first, burn pace as the tiebreak. Returns 0
 * for genuine ties so `Array.prototype.sort` keeps the incoming order and a
 * refresh cannot reshuffle equal cards.
 */
export function compareByUrgency(a: ProfileView, b: ProfileView): number {
  const tier = statusTier(a.tone) - statusTier(b.tone);
  if (tier !== 0) return tier;
  if (a.burn !== b.burn) return b.burn - a.burn;
  return 0;
}

export interface ProviderGroup {
  provider: ProviderId;
  label: string;
  profiles: ProfileView[];
  /** Worst headroom in the group — the number that decides its urgency. */
  headroom: number | null;
  tone: WindowTone;
  burn: number;
}

export function groupByProvider(
  views: readonly ProfileView[],
  labelFor: (provider: ProviderId) => string,
): ProviderGroup[] {
  const groups = new Map<ProviderId, ProfileView[]>();
  for (const view of views) {
    const bucket = groups.get(view.profile.provider);
    if (bucket) bucket.push(view);
    else groups.set(view.profile.provider, [view]);
  }

  return [...groups.entries()]
    .map(([provider, profiles]) => {
      const ordered = [...profiles].sort(compareByUrgency);
      const worst = ordered.find((view) => view.headroom !== null) ?? null;
      const headroom = ordered.reduce<number | null>(
        (lowest, view) =>
          view.headroom === null
            ? lowest
            : lowest === null
              ? view.headroom
              : Math.min(lowest, view.headroom),
        null,
      );
      return {
        provider,
        label: labelFor(provider),
        profiles: ordered,
        headroom,
        tone: headroom === null ? ('muted' as WindowTone) : toneOf(headroom),
        burn: worst?.burn ?? 0,
      };
    })
    .sort((a, b) => statusTier(a.tone) - statusTier(b.tone) || b.burn - a.burn || 0);
}

export interface TileOwner {
  profileLabel: string;
  providerLabel: string;
  windowLabel: string | null;
}

export interface Tiles {
  tightest: { remaining: number | null; tone: WindowTone; owner: TileOwner | null };
  nextReset: { atMs: number | null; owner: TileOwner | null };
  atRisk: { count: number; total: number; underHalf: number; tone: WindowTone };
  freshness: { stale: number; errors: number; oldestFetchedMs: number | null };
}

function ownerOf(view: ProfileView, window: WindowView | null): TileOwner {
  return {
    profileLabel: view.profile.label,
    providerLabel: view.profile.provider,
    windowLabel: window?.label ?? null,
  };
}

export function buildTiles(views: readonly ProfileView[]): Tiles {
  let tightestView: ProfileView | null = null;
  let nextView: ProfileView | null = null;
  let atRisk = 0;
  let underHalf = 0;
  let stale = 0;
  let errors = 0;
  let oldestFetchedMs: number | null = null;

  for (const view of views) {
    if (
      view.headroom !== null &&
      (tightestView === null || view.headroom < tightestView.headroom!)
    ) {
      tightestView = view;
    }
    if (
      view.nextResetMs !== null &&
      (nextView === null || view.nextResetMs < nextView.nextResetMs!)
    ) {
      nextView = view;
    }
    if (view.headroom !== null && view.headroom < 20) atRisk += 1;
    else if (view.headroom !== null && view.headroom < 50) underHalf += 1;

    if (view.snapshot?.stale) stale += 1;
    if (view.snapshot?.failureKind) errors += 1;
    const fetched = view.snapshot ? Date.parse(view.snapshot.fetchedAt) : Number.NaN;
    if (Number.isFinite(fetched) && (oldestFetchedMs === null || fetched < oldestFetchedMs)) {
      oldestFetchedMs = fetched;
    }
  }

  const remaining = tightestView?.headroom ?? null;
  return {
    tightest: {
      remaining,
      tone: remaining === null ? 'muted' : toneOf(remaining),
      owner: tightestView ? ownerOf(tightestView, tightestView.tightest) : null,
    },
    nextReset: {
      atMs: nextView?.nextResetMs ?? null,
      owner: nextView ? ownerOf(nextView, nextView.nextResetWindow) : null,
    },
    atRisk: {
      count: atRisk,
      total: views.length,
      underHalf,
      tone: atRisk > 0 ? 'destructive' : underHalf > 0 ? 'warning' : 'success',
    },
    freshness: { stale, errors, oldestFetchedMs },
  };
}

export interface Verdict {
  tone: WindowTone;
  best: ProfileView | null;
  headroom: number | null;
  /** Reset the headline profile is running towards, if any. */
  resetAtMs: number | null;
  /** The most pressured profile, mentioned in the trailing clause. */
  worst: ProfileView | null;
}

export function buildVerdict(views: readonly ProfileView[]): Verdict {
  let best: ProfileView | null = null;
  let worst: ProfileView | null = null;

  for (const view of views) {
    if (view.headroom === null) continue;
    if (best === null || view.headroom > best.headroom!) best = view;
    if (worst === null || view.headroom < worst.headroom!) worst = view;
  }

  return {
    tone: worst === null ? 'muted' : worst.tone,
    best,
    headroom: best?.headroom ?? null,
    resetAtMs: best?.nextResetMs ?? null,
    worst: worst && best && worst.profile.id === best.profile.id ? null : worst,
  };
}

/** `provider / label`, the way profiles are named throughout the dashboard. */
export function qualifiedName(view: ProfileView): string {
  return `${view.profile.provider} / ${view.profile.label}`;
}

/* ---- collapsed provider sections --------------------------------------- */

export const COLLAPSE_STORAGE_KEY = 'apm.dashboard.collapsed';

export interface CollapseStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readCollapsed(storage: CollapseStorage | null | undefined): string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(COLLAPSE_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export function writeCollapsed(
  storage: CollapseStorage | null | undefined,
  ids: readonly string[],
): void {
  if (!storage) return;
  try {
    storage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // Persistence is a convenience; a locked-down storage must not break the UI.
  }
}
