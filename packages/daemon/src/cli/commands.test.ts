import type {
  OverviewResponse,
  TargetProfilesResponse,
  TargetsResponse,
  UsageSnapshot,
} from '@apm/shared';
import { targetsCliResponseSchema } from '@apm/shared';
import { describe, expect, it } from 'vitest';
import {
  buildRunSessionRequest,
  profilesContract,
  targetProfilesContract,
  targetsContract,
} from './commands.js';

describe('buildRunSessionRequest', () => {
  it('forwards an explicit target cwd and opts into connection-bound lifecycle', () => {
    expect(
      buildRunSessionRequest(
        {
          target: 'dev-box',
          cwd: '/srv/work tree',
          ephemeral: true,
          profile: 'work',
          app: 'codex',
          args: ['--no-alt-screen'],
        },
        'remote-profile',
        { cols: 120, rows: 40 },
      ),
    ).toEqual({
      targetId: 'dev-box',
      profileId: 'remote-profile',
      app: 'codex',
      args: ['--no-alt-screen'],
      cwd: '/srv/work tree',
      lifecycle: 'connection-bound',
      cols: 120,
      rows: 40,
    });
  });

  it('keeps ordinary target sessions persistent and lets the target choose its default cwd', () => {
    expect(
      buildRunSessionRequest(
        {
          target: 'dev-box',
          ephemeral: false,
          profile: 'work',
          app: 'claude',
          args: [],
        },
        'remote-profile',
        { cols: 80, rows: 24 },
      ),
    ).toEqual({
      targetId: 'dev-box',
      profileId: 'remote-profile',
      app: 'claude',
      args: [],
      cols: 80,
      rows: 24,
    });
  });
});

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

  it('cannot emit duplicate profile ids', () => {
    const overview = singleProfileOverview('duplicate');
    overview.profiles.push({
      ...overview.profiles[0]!,
      label: 'other',
      home: '/profiles/other',
    });

    expect(() => profilesContract(overview)).toThrow(
      /profiles\[1\]\.id duplicates profiles\[0\]\.id/,
    );
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

describe('target integration contracts', () => {
  it('emits versioned target metadata without credential material', () => {
    const response: TargetsResponse = {
      targets: [
        {
          id: 'dev-box',
          label: 'Dev Box',
          kind: 'remote',
          transport: 'ssh',
          identity: {
            hostname: 'dev-box',
            address: 'dev-box.example',
            fingerprint: null,
          },
          capabilities: ['exec', 'pty', 'signal', 'profiles', 'detached'],
          approved: true,
          status: 'online',
        },
      ],
    };

    expect(targetsContract(response)).toEqual({ schemaVersion: 1, targets: response.targets });
  });

  it('keeps capability names forward-compatible in schema version 1', () => {
    const parsed = targetsCliResponseSchema.parse({
      schemaVersion: 1,
      targets: [
        {
          id: 'dev-box',
          label: 'Dev Box',
          kind: 'remote',
          transport: 'ssh',
          identity: { hostname: 'dev-box', address: 'dev-box.example', fingerprint: null },
          capabilities: ['pty', 'detached', 'future-capability'],
          approved: true,
          status: 'online',
        },
      ],
    });

    expect(parsed.targets[0]?.capabilities).toEqual(['pty', 'detached', 'future-capability']);
  });

  it('emits target-scoped profiles without homes and preserves opaque ids', () => {
    const id = 'remote/work 日本';
    const response: TargetProfilesResponse = {
      profiles: [
        {
          id,
          provider: 'codex',
          label: 'Remote work',
          status: 'active',
          enabled: true,
        },
      ],
    };

    const contract = targetProfilesContract('dev-box', response);
    expect(contract).toEqual({
      schemaVersion: 1,
      targetId: 'dev-box',
      profiles: response.profiles,
    });
    expect(JSON.stringify(contract)).not.toContain('home');
  });

  it('rejects duplicate target-scoped profile ids', () => {
    const profile = {
      id: 'duplicate',
      provider: 'claude' as const,
      label: 'Work',
      status: 'active' as const,
      enabled: true,
    };
    expect(() =>
      targetProfilesContract('dev-box', { profiles: [profile, { ...profile, label: 'Other' }] }),
    ).toThrow(/duplicates/);
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
