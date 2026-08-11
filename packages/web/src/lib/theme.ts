/* Color-scheme preference logic. Deliberately DOM-free (every browser touch
 * point is passed in) so it stays unit testable; theme.svelte.ts wires it to
 * the real window. */

/** What the user picked. `system` follows the OS. */
export type ThemePreference = 'system' | 'light' | 'dark';
/** What actually gets painted. */
export type ColorScheme = 'light' | 'dark';

export const DEFAULT_PREFERENCE: ThemePreference = 'system';

export const THEME_STORAGE_KEY = 'apm.theme';

/** Matching *light* rather than dark keeps dark the fallback for browsers that
 * report no preference at all — apm was dark-only before light mode existed.
 * The pre-paint snippet in index.html mirrors this query; keep them in sync. */
export const LIGHT_SCHEME_QUERY = '(prefers-color-scheme: light)';

/** Anything unrecognised (stale value, tampered storage, null) means `system`. */
export function normalizePreference(value: unknown): ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system' ? value : DEFAULT_PREFERENCE;
}

export function resolveScheme(preference: ThemePreference, systemScheme: ColorScheme): ColorScheme {
  return preference === 'system' ? systemScheme : preference;
}

export function schemeFromLightQuery(prefersLight: boolean): ColorScheme {
  return prefersLight ? 'light' : 'dark';
}

export type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function readPreference(storage: PreferenceStorage | null | undefined): ThemePreference {
  try {
    return normalizePreference(storage?.getItem(THEME_STORAGE_KEY));
  } catch {
    // Storage can throw outright (disabled cookies, sandboxed frame).
    return DEFAULT_PREFERENCE;
  }
}

export function writePreference(
  storage: PreferenceStorage | null | undefined,
  preference: ThemePreference,
): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // A theme that cannot be remembered is still worth showing.
  }
}

/** Structural subset of HTMLElement — `document.documentElement` satisfies it. */
export interface SchemeTarget {
  dataset: { theme?: string };
  style: { colorScheme: string };
}

/** `data-theme` drives the token blocks, `color-scheme` the native widgets. */
export function applyScheme(target: SchemeTarget, scheme: ColorScheme): void {
  target.dataset.theme = scheme;
  target.style.colorScheme = scheme;
}
