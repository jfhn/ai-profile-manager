import {
  applyScheme,
  LIGHT_SCHEME_QUERY,
  readPreference,
  resolveScheme,
  schemeFromLightQuery,
  writePreference,
} from './theme';
import type { ColorScheme, PreferenceStorage, ThemePreference } from './theme';

function mediaQuery(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  return window.matchMedia(LIGHT_SCHEME_QUERY);
}

function storage(): PreferenceStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

const media = mediaQuery();

class ThemeStore {
  /** What the user picked; persisted across reloads. */
  preference = $state<ThemePreference>(readPreference(storage()));
  /** What the OS currently asks for; kept live by a matchMedia listener. */
  #system = $state<ColorScheme>(schemeFromLightQuery(media?.matches ?? false));

  /** The scheme actually painted right now. */
  scheme: ColorScheme = $derived(resolveScheme(this.preference, this.#system));

  constructor() {
    media?.addEventListener('change', (event) => {
      this.#system = schemeFromLightQuery(event.matches);
      this.#apply();
    });
    // index.html already applied this before first paint; re-applying keeps the
    // DOM honest if storage changed since (and covers the dev-server path).
    this.#apply();
  }

  select(preference: ThemePreference): void {
    this.preference = preference;
    writePreference(storage(), preference);
    this.#apply();
  }

  #apply(): void {
    if (typeof document === 'undefined') return;
    applyScheme(document.documentElement, this.scheme);
  }
}

export const theme = new ThemeStore();
