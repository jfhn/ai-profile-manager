import type { OverviewResponse, UsageSnapshot } from '@apm/shared';
import { describe, expect, it } from 'vitest';
import { profilesContract } from './commands.js';

describe('profilesContract', () => {
  it('emits the versioned integration shape with explicit null usage', () => {
    const overview: OverviewResponse = {
      providers: [
        {
          id: 'claude',
          label: 'Claude',
          capabilities: { usage: true, usageSources: ['oauth-api'], identity: true, windows: [] },
        },
      ],
      profiles: [
        {
          id: 'claude-work',
          provider: 'claude',
          label: 'work',
          home: '/profiles/claude-work',
          homeKind: 'managed',
          identity: { account: 'secret@example.test', organization: null, plan: 'pro' },
          status: 'active',
          statusReason: null,
          enabled: true,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'claude-pending',
          provider: 'claude',
          label: 'pending',
          home: '/profiles/claude-pending',
          homeKind: 'managed',
          identity: null,
          status: 'pending',
          statusReason: null,
          enabled: true,
          createdAt: '2026-01-02T00:00:00.000Z',
        },
      ],
      defaultProfileIds: { claude: 'claude-work' },
      usage: { 'claude-work': usage('claude-work') },
      sessions: [],
      t3Instances: [],
    };

    expect(profilesContract(overview)).toEqual({
      schemaVersion: 1,
      defaultProfileIds: { claude: 'claude-work' },
      profiles: [
        {
          id: 'claude-work',
          provider: 'claude',
          label: 'work',
          home: '/profiles/claude-work',
          status: 'active',
          enabled: true,
          usage: usage('claude-work'),
        },
        {
          id: 'claude-pending',
          provider: 'claude',
          label: 'pending',
          home: '/profiles/claude-pending',
          status: 'pending',
          enabled: true,
          usage: null,
        },
      ],
    });
  });

  it('preserves valid opaque ids exactly and enforces their UTF-8 boundary', () => {
    const id = ` ${'é'.repeat(127)}!`;
    expect(Buffer.byteLength(id, 'utf8')).toBe(256);
    const overview = singleProfileOverview(id);

    expect(profilesContract(overview)).toMatchObject({
      defaultProfileIds: { claude: id },
      profiles: [{ id }],
    });

    overview.profiles[0]!.id = `${id}a`;
    overview.defaultProfileIds = { claude: `${id}a` };
    expect(() => profilesContract(overview)).toThrow(/256 UTF-8 bytes/);
  });

  it.each(['control\u0000id', '   '])('rejects an invalid contract profile id %j', (id) => {
    expect(() => profilesContract(singleProfileOverview(id))).toThrow();
  });

  it('cannot emit a relative profile home', () => {
    const overview = singleProfileOverview('claude-work');
    overview.profiles[0]!.home = 'relative/homes/claude-work';

    expect(() => profilesContract(overview)).toThrow(/profile homes must be absolute paths/);
  });

  it('keeps schema-version 1 provider values and default keys closed', () => {
    const unknownDefault = singleProfileOverview('claude-work');
    (unknownDefault.defaultProfileIds as Record<string, string>).openai = 'claude-work';
    expect(() => profilesContract(unknownDefault)).toThrow(/Unrecognized key/);

    const unknownProvider = singleProfileOverview('claude-work');
    (unknownProvider.profiles[0] as { provider: string }).provider = 'openai';
    expect(() => profilesContract(unknownProvider)).toThrow(/Invalid enum value/);
  });

  it('downgrades malformed or mismatched usage to null', () => {
    const overview = singleProfileOverview('claude-work');
    overview.usage = {
      'claude-work': {
        ...usage('another-profile'),
        windows: [
          {
            id: 'weekly',
            label: '7d',
            usedPercent: 101,
            remainingPercent: -1,
            resetAt: 'not-a-timestamp',
          },
        ],
      },
    };

    expect(profilesContract(overview).profiles[0]?.usage).toBeNull();
  });
});

function singleProfileOverview(id: string): OverviewResponse {
  return {
    providers: [
      {
        id: 'claude',
        label: 'Claude',
        capabilities: { usage: true, usageSources: ['oauth-api'], identity: true, windows: [] },
      },
    ],
    profiles: [
      {
        id,
        provider: 'claude',
        label: 'work',
        home: '/profiles/work',
        homeKind: 'managed',
        identity: null,
        status: 'active',
        statusReason: null,
        enabled: true,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    defaultProfileIds: { claude: id },
    usage: {},
    sessions: [],
    t3Instances: [],
  };
}

function usage(profileId: string): UsageSnapshot {
  return {
    profileId,
    windows: [],
    fetchedAt: '2026-01-01T00:00:00.000Z',
    source: 'test',
    cacheStatus: 'live',
    dataUpdatedAt: null,
    stale: false,
    staleReason: null,
    failureKind: null,
    error: null,
    planType: null,
    retryAfterSeconds: null,
  };
}
