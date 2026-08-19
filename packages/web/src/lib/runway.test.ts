import { describe, expect, it } from 'vitest';
import type { Profile, ProviderId, UsageSnapshot, UsageWindow } from '@apm/shared';
import {
  buildTiles,
  buildVerdict,
  burnPace,
  compareByUrgency,
  groupByProvider,
  profileView,
  readCollapsed,
  statusTier,
  windowView,
  writeCollapsed,
  COLLAPSE_STORAGE_KEY,
} from './runway';

const NOW = Date.parse('2026-01-10T12:00:00.000Z');
const HOUR = 3_600_000;

function iso(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: overrides.id ?? 'p1',
    provider: (overrides.provider ?? 'claude') as ProviderId,
    label: overrides.label ?? 'personal',
    home: '/home/jan/.apm/claude/personal',
    homeKind: 'managed',
    enabled: true,
    status: 'active',
    statusReason: null,
    identity: null,
    createdAt: iso(-HOUR),
    ...overrides,
  } as Profile;
}

function makeWindow(overrides: Partial<UsageWindow> = {}): UsageWindow {
  return {
    id: 'weekly',
    label: '7d',
    usedPercent: null,
    remainingPercent: 50,
    resetAt: iso(24 * HOUR),
    ...overrides,
  };
}

function makeSnapshot(
  windows: UsageWindow[],
  overrides: Partial<UsageSnapshot> = {},
): UsageSnapshot {
  return {
    profileId: 'p1',
    windows,
    fetchedAt: iso(-60_000),
    source: 'oauth',
    cacheStatus: 'live',
    dataUpdatedAt: null,
    stale: false,
    staleReason: null,
    failureKind: null,
    error: null,
    planType: 'pro',
    retryAfterSeconds: null,
    ...overrides,
  };
}

describe('windowView', () => {
  it('derives the elapsed fraction from the known window length', () => {
    // A 7d weekly window resetting in 24h is 6/7 elapsed.
    const view = windowView(makeWindow({ id: 'weekly', resetAt: iso(24 * HOUR) }), NOW);
    expect(view.elapsedFraction).toBeCloseTo(6 / 7, 5);
    expect(view.label).toBe('Weekly');
  });

  it('labels the Fable-scoped weekly window distinctly', () => {
    expect(windowView(makeWindow({ id: 'fable_weekly' }), NOW).label).toBe('Weekly · Fable 5');
  });

  it('falls back to the adapter label for unknown window ids', () => {
    const view = windowView(makeWindow({ id: 'quarterly', label: '90d' }), NOW);
    expect(view.label).toBe('90d');
    expect(view.elapsedFraction).toBeNull();
  });

  it('treats Cursor spend windows as monthly', () => {
    const resetAt = iso(24 * HOUR);
    const monthly = windowView(makeWindow({ id: 'monthly', resetAt }), NOW);
    const cursorModels = windowView(makeWindow({ id: 'cursor_models', resetAt }), NOW);
    const otherModels = windowView(makeWindow({ id: 'other_models', resetAt }), NOW);
    expect(cursorModels.elapsedFraction).toBe(monthly.elapsedFraction);
    expect(otherModels.elapsedFraction).toBe(monthly.elapsedFraction);
    expect(cursorModels.label).toBe('Cursor Models');
    expect(otherModels.label).toBe('Other Models');
  });

  it('marks an unreported window as muted with no score', () => {
    const view = windowView(makeWindow({ remainingPercent: null, usedPercent: null }), NOW);
    expect(view.remaining).toBeNull();
    expect(view.tone).toBe('muted');
    expect(view.burn).toBeNull();
  });

  it('reads remaining from usedPercent when the provider only reports usage', () => {
    const view = windowView(makeWindow({ remainingPercent: null, usedPercent: 90 }), NOW);
    expect(view.remaining).toBe(10);
    expect(view.tone).toBe('destructive');
  });
});

describe('burnPace', () => {
  it('scores consumption against elapsed window time', () => {
    // 60% consumed a quarter of the way in = 4x the sustainable pace.
    expect(burnPace(40, 0.25, NOW + HOUR, NOW)).toBeCloseTo(240, 5);
    // On pace: 25% consumed a quarter in.
    expect(burnPace(75, 0.25, NOW + HOUR, NOW)).toBeCloseTo(100, 5);
  });

  it('falls back to remaining per hour when the window start is unknown', () => {
    expect(burnPace(50, null, NOW + 2 * HOUR, NOW)).toBeCloseTo(25, 5);
  });

  it('has no score without a remaining percentage or a future reset', () => {
    expect(burnPace(null, 0.5, NOW + HOUR, NOW)).toBeNull();
    expect(burnPace(50, null, null, NOW)).toBeNull();
    expect(burnPace(50, null, NOW - HOUR, NOW)).toBeNull();
    expect(burnPace(50, 0, null, NOW)).toBeNull();
  });
});

describe('profileView', () => {
  it('takes the worst window for headroom, tone and burn', () => {
    const view = profileView(
      makeProfile(),
      makeSnapshot([
        makeWindow({ id: 'five_hour', label: '5h', remainingPercent: 80, resetAt: iso(HOUR) }),
        makeWindow({ id: 'weekly', remainingPercent: 15, resetAt: iso(24 * HOUR) }),
        makeWindow({ id: 'fable_weekly', remainingPercent: 60, resetAt: iso(24 * HOUR) }),
      ]),
      NOW,
    );
    expect(view.headroom).toBe(15);
    expect(view.tone).toBe('destructive');
    // Weekly is 6/7 elapsed with 85% burnt (≈99); the 5h window is 4/5 elapsed
    // with 20% burnt (25), so the weekly window sets the pace.
    expect(view.burn).toBeCloseTo(85 / (6 / 7), 5);
    expect(view.nextResetMs).toBe(NOW + HOUR);
  });

  it('orders windows 5h, weekly, Fable weekly regardless of snapshot order', () => {
    const view = profileView(
      makeProfile(),
      makeSnapshot([
        makeWindow({ id: 'fable_weekly' }),
        makeWindow({ id: 'weekly' }),
        makeWindow({ id: 'five_hour' }),
      ]),
      NOW,
    );
    expect(view.windows.map((window) => window.id)).toEqual([
      'five_hour',
      'weekly',
      'fable_weekly',
    ]);
  });

  it('stays muted with no snapshot at all', () => {
    const view = profileView(makeProfile(), undefined, NOW);
    expect(view.windows).toEqual([]);
    expect(view.headroom).toBeNull();
    expect(view.tone).toBe('muted');
    expect(view.burn).toBe(0);
  });

  it('ignores unreported windows when scoring', () => {
    const view = profileView(
      makeProfile(),
      makeSnapshot([
        makeWindow({ id: 'five_hour', remainingPercent: null, usedPercent: null }),
        makeWindow({ id: 'weekly', remainingPercent: 30, resetAt: iso(24 * HOUR) }),
      ]),
      NOW,
    );
    expect(view.headroom).toBe(30);
    expect(view.windows[0]?.tone).toBe('muted');
  });
});

describe('compareByUrgency', () => {
  function view(id: string, remaining: number, resetIn: number): ReturnType<typeof profileView> {
    return profileView(
      makeProfile({ id, label: id }),
      makeSnapshot([makeWindow({ remainingPercent: remaining, resetAt: iso(resetIn) })]),
      NOW,
    );
  }

  it('puts destructive before warning before healthy', () => {
    const healthy = view('a', 80, 24 * HOUR);
    const warning = view('b', 30, 24 * HOUR);
    const destructive = view('c', 5, 24 * HOUR);
    const sorted = [healthy, warning, destructive].sort(compareByUrgency);
    expect(sorted.map((item) => item.profile.id)).toEqual(['c', 'b', 'a']);
    expect(statusTier('destructive')).toBeLessThan(statusTier('warning'));
    expect(statusTier('warning')).toBeLessThan(statusTier('success'));
    expect(statusTier('muted')).toBe(statusTier('success'));
  });

  it('breaks ties inside a tier by burn pace', () => {
    // Same tone, but the one that burnt its quota earlier in the window leads.
    const slow = view('slow', 60, 24 * HOUR); // 6/7 elapsed, 40 burnt
    const fast = view('fast', 60, 6 * 24 * HOUR); // 1/7 elapsed, 40 burnt
    const sorted = [slow, fast].sort(compareByUrgency);
    expect(sorted.map((item) => item.profile.id)).toEqual(['fast', 'slow']);
  });

  it('is stable for genuinely equal profiles', () => {
    const first = view('one', 60, 24 * HOUR);
    const second = view('two', 60, 24 * HOUR);
    const third = view('three', 60, 24 * HOUR);
    expect(compareByUrgency(first, second)).toBe(0);
    const order = [first, second, third].sort(compareByUrgency).map((item) => item.profile.id);
    expect(order).toEqual(['one', 'two', 'three']);
    // Sorting the already-sorted list again must not reshuffle it.
    expect(
      [first, second, third]
        .sort(compareByUrgency)
        .sort(compareByUrgency)
        .map((i) => i.profile.id),
    ).toEqual(['one', 'two', 'three']);
  });

  it('treats profiles without usage as untiered but never urgent', () => {
    const unknown = profileView(makeProfile({ id: 'unknown' }), undefined, NOW);
    const warning = view('warn', 30, 24 * HOUR);
    expect([unknown, warning].sort(compareByUrgency).map((i) => i.profile.id)).toEqual([
      'warn',
      'unknown',
    ]);
  });
});

describe('groupByProvider', () => {
  const labelFor = (provider: ProviderId): string =>
    provider === 'claude' ? 'Claude Code' : 'Codex';

  it('groups, orders sections by urgency and reports the worst headroom', () => {
    const views = [
      profileView(
        makeProfile({ id: 'c1', provider: 'claude', label: 'personal' }),
        makeSnapshot([makeWindow({ remainingPercent: 95 })]),
        NOW,
      ),
      profileView(
        makeProfile({ id: 'x1', provider: 'codex', label: 'work' }),
        makeSnapshot([makeWindow({ remainingPercent: 12 })]),
        NOW,
      ),
      profileView(
        makeProfile({ id: 'x2', provider: 'codex', label: 'personal' }),
        makeSnapshot([makeWindow({ remainingPercent: 92 })]),
        NOW,
      ),
    ];
    const groups = groupByProvider(views, labelFor);
    expect(groups.map((group) => group.provider)).toEqual(['codex', 'claude']);
    expect(groups[0]?.label).toBe('Codex');
    expect(groups[0]?.headroom).toBe(12);
    expect(groups[0]?.tone).toBe('destructive');
    expect(groups[0]?.profiles.map((view) => view.profile.id)).toEqual(['x1', 'x2']);
    expect(groups[1]?.headroom).toBe(95);
  });

  it('keeps a provider with no usage data in a muted state', () => {
    const groups = groupByProvider(
      [profileView(makeProfile({ provider: 'codex' }), undefined, NOW)],
      labelFor,
    );
    expect(groups[0]?.headroom).toBeNull();
    expect(groups[0]?.tone).toBe('muted');
  });
});

describe('buildTiles', () => {
  const views = [
    profileView(
      makeProfile({ id: 'x1', provider: 'codex', label: 'work' }),
      makeSnapshot([makeWindow({ id: 'weekly', remainingPercent: 12, resetAt: iso(48 * HOUR) })]),
      NOW,
    ),
    profileView(
      makeProfile({ id: 'c1', provider: 'claude', label: 'ci-bot' }),
      makeSnapshot(
        [
          makeWindow({ id: 'five_hour', remainingPercent: 34, resetAt: iso(3 * HOUR) }),
          makeWindow({ id: 'weekly', remainingPercent: 58, resetAt: iso(48 * HOUR) }),
        ],
        { stale: true, fetchedAt: iso(-42 * 60_000) },
      ),
      NOW,
    ),
    profileView(
      makeProfile({ id: 'c2', provider: 'claude', label: 'personal' }),
      makeSnapshot([makeWindow({ id: 'weekly', remainingPercent: 95, resetAt: iso(120 * HOUR) })]),
      NOW,
    ),
  ];

  it('names the tightest window and who owns it', () => {
    const tiles = buildTiles(views);
    expect(tiles.tightest.remaining).toBe(12);
    expect(tiles.tightest.tone).toBe('destructive');
    expect(tiles.tightest.owner).toEqual({
      profileLabel: 'work',
      providerLabel: 'codex',
      windowLabel: 'Weekly',
    });
  });

  it('finds the soonest reset across every profile and window', () => {
    const tiles = buildTiles(views);
    expect(tiles.nextReset.atMs).toBe(NOW + 3 * HOUR);
    expect(tiles.nextReset.owner?.profileLabel).toBe('ci-bot');
    expect(tiles.nextReset.owner?.windowLabel).toBe('5h');
  });

  it('counts profiles under 20% as at risk and under 50% separately', () => {
    const tiles = buildTiles(views);
    expect(tiles.atRisk).toMatchObject({ count: 1, total: 3, underHalf: 1, tone: 'destructive' });
  });

  it('rolls up staleness, errors and the oldest fetch', () => {
    const tiles = buildTiles(views);
    expect(tiles.freshness.stale).toBe(1);
    expect(tiles.freshness.errors).toBe(0);
    expect(tiles.freshness.oldestFetchedMs).toBe(NOW - 42 * 60_000);
  });

  it('degrades cleanly with no profiles', () => {
    const tiles = buildTiles([]);
    expect(tiles.tightest).toEqual({ remaining: null, tone: 'muted', owner: null });
    expect(tiles.nextReset).toEqual({ atMs: null, owner: null });
    expect(tiles.atRisk).toMatchObject({ count: 0, total: 0, tone: 'success' });
    expect(tiles.freshness.oldestFetchedMs).toBeNull();
  });

  it('ignores unreported windows when picking the tightest', () => {
    const tiles = buildTiles([
      profileView(
        makeProfile(),
        makeSnapshot([
          makeWindow({ id: 'five_hour', remainingPercent: null, usedPercent: null }),
          makeWindow({ id: 'weekly', remainingPercent: 44 }),
        ]),
        NOW,
      ),
    ]);
    expect(tiles.tightest.remaining).toBe(44);
    expect(tiles.tightest.owner?.windowLabel).toBe('Weekly');
  });
});

describe('buildVerdict', () => {
  it('names the profile with the most headroom and the most pressured one', () => {
    const verdict = buildVerdict([
      profileView(
        makeProfile({ id: 'x1', provider: 'codex', label: 'work' }),
        makeSnapshot([makeWindow({ remainingPercent: 12, resetAt: iso(48 * HOUR) })]),
        NOW,
      ),
      profileView(
        makeProfile({ id: 'c1', provider: 'claude', label: 'personal' }),
        makeSnapshot([makeWindow({ remainingPercent: 95, resetAt: iso(120 * HOUR) })]),
        NOW,
      ),
    ]);
    expect(verdict.best?.profile.label).toBe('personal');
    expect(verdict.headroom).toBe(95);
    expect(verdict.resetAtMs).toBe(NOW + 120 * HOUR);
    expect(verdict.worst?.profile.label).toBe('work');
    // The overall tone follows the worst profile, so the line reads as a warning.
    expect(verdict.tone).toBe('destructive');
  });

  it('drops the trailing clause when one profile is both best and worst', () => {
    const verdict = buildVerdict([
      profileView(makeProfile(), makeSnapshot([makeWindow({ remainingPercent: 70 })]), NOW),
    ]);
    expect(verdict.best?.profile.id).toBe('p1');
    expect(verdict.worst).toBeNull();
    expect(verdict.tone).toBe('success');
  });

  it('has nothing to say without usable usage', () => {
    const verdict = buildVerdict([profileView(makeProfile(), undefined, NOW)]);
    expect(verdict.best).toBeNull();
    expect(verdict.headroom).toBeNull();
    expect(verdict.tone).toBe('muted');
  });
});

describe('collapse persistence', () => {
  function fakeStorage(initial?: string): {
    value: string | null;
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
  } {
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

  it('round-trips collapsed provider ids under a stable key', () => {
    const storage = fakeStorage();
    writeCollapsed(storage, ['codex']);
    expect(storage.getItem(COLLAPSE_STORAGE_KEY)).toBe('["codex"]');
    expect(readCollapsed(storage)).toEqual(['codex']);
  });

  it('reads nothing from empty, absent or corrupt storage', () => {
    expect(readCollapsed(null)).toEqual([]);
    expect(readCollapsed(fakeStorage())).toEqual([]);
    expect(readCollapsed(fakeStorage('not json'))).toEqual([]);
    expect(readCollapsed(fakeStorage('{"a":1}'))).toEqual([]);
    expect(readCollapsed(fakeStorage('[1,"codex"]'))).toEqual(['codex']);
  });

  it('survives storage that throws', () => {
    const throwing = {
      getItem(): string {
        throw new Error('denied');
      },
      setItem(): void {
        throw new Error('denied');
      },
    };
    expect(readCollapsed(throwing)).toEqual([]);
    expect(() => writeCollapsed(throwing, ['codex'])).not.toThrow();
  });
});
