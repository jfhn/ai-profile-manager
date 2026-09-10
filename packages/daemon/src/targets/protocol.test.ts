import { describe, expect, it } from 'vitest';
import { TransportError } from '@apm/shared';
import {
  agentRequestSchema,
  agentResponseSchema,
  encodeAgentMessage,
  type AgentRequest,
} from './protocol.js';
import { isLegacySyncRejection } from './ssh.js';

describe('target agent protocol', () => {
  it('round-trips argv, env and cwd as structured JSON values', () => {
    const request: AgentRequest = {
      type: 'pty',
      spec: {
        argv: ['claude', 'two words', '$(still-an-argument)', 'line\nbreak', '--', '-x'],
        env: { APM_APPROVED_VALUE: 'semi;colon' },
        cwd: '/work tree/project',
        profileIds: ['profile-1'],
        cols: 120,
        rows: 40,
      },
    };

    const encoded = encodeAgentMessage(request);
    expect(encoded.endsWith('\n')).toBe(true);
    expect(agentRequestSchema.parse(JSON.parse(encoded))).toEqual(request);
  });

  it('carries every bound profile id — one per provider — as opaque values', () => {
    const request: AgentRequest = {
      type: 'pty',
      spec: {
        argv: ['claude', '--resume'],
        cwd: '/home/dev/project',
        profileIds: ['claude-remote', 'codex remote (opaque id)'],
        cols: 120,
        rows: 40,
      },
    };

    const parsed = agentRequestSchema.parse(JSON.parse(encodeAgentMessage(request)));
    expect(parsed).toEqual(request);
    // Ids only: nothing about homes or provider env may appear in the spec.
    expect(JSON.stringify(parsed)).not.toContain('CLAUDE_CONFIG_DIR');
  });

  it('keeps the profiles a newer remote reports for providers this build knows', () => {
    const response = {
      type: 'profiles',
      profiles: [
        {
          id: 'claude-remote',
          provider: 'claude',
          label: 'work',
          status: 'active',
          enabled: true,
        },
        {
          id: 'gemini-remote',
          provider: 'gemini',
          label: 'work',
          status: 'active',
          enabled: true,
        },
      ],
    };

    const parsed = agentResponseSchema.parse(response);
    expect(parsed).toEqual({ type: 'profiles', profiles: [response.profiles[0]] });
  });

  it('rejects the whole profile list when an entry of a known provider is malformed', () => {
    const response = {
      type: 'profiles',
      profiles: [
        { id: 'claude-remote', provider: 'claude', label: 'work', status: 'active', enabled: true },
        { id: 'codex-remote', provider: 'codex', label: 'work', status: 'sleeping', enabled: true },
      ],
    };

    expect(agentResponseSchema.safeParse(response).success).toBe(false);
  });

  it('rejects a blank profile id instead of forwarding it to the target', () => {
    const spec = {
      argv: ['claude'],
      profileIds: ['claude-remote', '  '],
      cols: 80,
      rows: 24,
    };
    expect(agentRequestSchema.safeParse({ type: 'pty', spec }).success).toBe(false);
  });

  it('round-trips the sync messages and validates both directions', () => {
    const bundle = {
      provider: 'claude',
      rotatedAt: '2026-08-20T10:00:00.000Z',
      payload: { claudeAiOauth: { accessToken: 'token-1' } },
    };
    const syncId = '11111111-2222-4333-8444-555555555555';

    const pull: AgentRequest = { type: 'sync-pull', syncId, role: 'replica' };
    expect(agentRequestSchema.parse(JSON.parse(encodeAgentMessage(pull)))).toEqual(pull);

    const push: AgentRequest = { type: 'sync-push', syncId, role: 'owner', bundle };
    expect(agentRequestSchema.parse(JSON.parse(encodeAgentMessage(push)))).toEqual(push);

    const enroll: AgentRequest = {
      type: 'sync-enroll',
      syncId,
      role: 'owner',
      provider: 'claude',
      label: 'work',
      bundle,
    };
    expect(agentRequestSchema.parse(JSON.parse(encodeAgentMessage(enroll)))).toEqual(enroll);

    expect(agentResponseSchema.parse({ type: 'sync-bundle', bundle })).toEqual({
      type: 'sync-bundle',
      bundle,
    });
    expect(agentResponseSchema.parse({ type: 'sync-applied', applied: false })).toEqual({
      type: 'sync-applied',
      applied: false,
    });
    const profile = {
      id: 'copied-profile',
      provider: 'claude',
      label: 'work',
      status: 'active',
      enabled: true,
    } as const;
    expect(agentResponseSchema.parse({ type: 'sync-enrolled', profile })).toEqual({
      type: 'sync-enrolled',
      profile,
    });

    // Not a UUID: rejected before it can reach store matching.
    expect(
      agentRequestSchema.safeParse({ type: 'sync-pull', syncId: '../etc', role: 'owner' }).success,
    ).toBe(false);
    // An oversized payload is rejected by the bundle size cap — measured in
    // UTF-8 bytes, so multi-byte characters cannot smuggle past it.
    const huge = { blob: 'x'.repeat(65 * 1024) };
    expect(
      agentRequestSchema.safeParse({
        type: 'sync-push',
        syncId,
        role: 'owner',
        bundle: { ...bundle, payload: huge },
      }).success,
    ).toBe(false);
    const hugeMultiByte = { blob: '€'.repeat(30 * 1024) };
    expect(
      agentRequestSchema.safeParse({
        type: 'sync-push',
        syncId,
        role: 'owner',
        bundle: { ...bundle, payload: hugeMultiByte },
      }).success,
    ).toBe(false);
  });

  it('treats only the fixed pre-sync rejection strings as "old peer"', () => {
    const legacy = (message: string) => new TransportError('spawn-failed', 't', message);
    expect(isLegacySyncRejection(legacy('Invalid target-agent request'))).toBe(true);
    expect(isLegacySyncRejection(legacy('Malformed target-agent request'))).toBe(true);
    // A genuine sync failure on a current agent must surface as itself.
    expect(isLegacySyncRejection(legacy('EACCES: permission denied'))).toBe(false);
    expect(
      isLegacySyncRejection(new TransportError('unreachable', 't', 'Invalid target-agent request')),
    ).toBe(false);
  });
});
