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
});

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
