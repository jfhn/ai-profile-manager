import { describe, expect, it } from 'vitest';
import {
  applyScheme,
  DEFAULT_PREFERENCE,
  normalizePreference,
  readPreference,
  resolveScheme,
  schemeFromLightQuery,
  THEME_STORAGE_KEY,
  writePreference,
} from './theme';
import type { PreferenceStorage, ThemePreference } from './theme';

function fakeStorage(initial?: string): PreferenceStorage & { value: string | null } {
  return {
    value: initial ?? null,
    getItem() {
      return this.value;
    },
    setItem(_key: string, next: string) {
      this.value = next;
    },
  };
}

const throwingStorage: PreferenceStorage = {
  getItem() {
    throw new Error('storage disabled');
  },
  setItem() {
    throw new Error('storage disabled');
  },
};

describe('normalizePreference', () => {
  it('keeps the three known preferences', () => {
    for (const preference of ['system', 'light', 'dark'] as ThemePreference[]) {
      expect(normalizePreference(preference)).toBe(preference);
    }
  });

  it('falls back to system for anything else', () => {
    for (const value of [null, undefined, '', 'Dark', 'auto', 0, {}]) {
      expect(normalizePreference(value)).toBe('system');
    }
  });

  it('defaults to system', () => {
    expect(DEFAULT_PREFERENCE).toBe('system');
  });
});

describe('resolveScheme', () => {
  it('honours an explicit choice regardless of the system scheme', () => {
    expect(resolveScheme('light', 'dark')).toBe('light');
    expect(resolveScheme('light', 'light')).toBe('light');
    expect(resolveScheme('dark', 'light')).toBe('dark');
    expect(resolveScheme('dark', 'dark')).toBe('dark');
  });

  it('follows the system scheme when set to system', () => {
    expect(resolveScheme('system', 'light')).toBe('light');
    expect(resolveScheme('system', 'dark')).toBe('dark');
  });

  it('reads the system scheme off the prefers-light query', () => {
    expect(schemeFromLightQuery(true)).toBe('light');
    // No stated preference stays dark, matching apm before light mode existed.
    expect(schemeFromLightQuery(false)).toBe('dark');
  });
});

describe('persistence', () => {
  it('round-trips a preference through storage', () => {
    const storage = fakeStorage();
    writePreference(storage, 'light');
    expect(storage.value).toBe('light');
    expect(readPreference(storage)).toBe('light');
  });

  it('stores under a stable key', () => {
    const storage = fakeStorage();
    writePreference(storage, 'dark');
    expect(THEME_STORAGE_KEY).toBe('apm.theme');
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('reads system when nothing is stored', () => {
    expect(readPreference(fakeStorage())).toBe('system');
    expect(readPreference(null)).toBe('system');
    expect(readPreference(undefined)).toBe('system');
  });

  it('sanitises a stored value it does not recognise', () => {
    expect(readPreference(fakeStorage('sepia'))).toBe('system');
  });

  it('survives storage that throws', () => {
    expect(readPreference(throwingStorage)).toBe('system');
    expect(() => writePreference(throwingStorage, 'dark')).not.toThrow();
  });
});

describe('applyScheme', () => {
  it('sets both the token hook and the native color-scheme', () => {
    const target = { dataset: {} as { theme?: string }, style: { colorScheme: '' } };

    applyScheme(target, 'light');
    expect(target.dataset.theme).toBe('light');
    expect(target.style.colorScheme).toBe('light');

    applyScheme(target, 'dark');
    expect(target.dataset.theme).toBe('dark');
    expect(target.style.colorScheme).toBe('dark');
  });
});
