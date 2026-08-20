import { describe, expect, it } from 'vitest';
import {
  agentRequestSchema,
  agentResponseSchema,
  encodeAgentMessage,
  type AgentRequest,
} from './protocol.js';

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

    expect(agentResponseSchema.parse({ type: 'sync-bundle', bundle })).toEqual({
      type: 'sync-bundle',
      bundle,
    });
    expect(agentResponseSchema.parse({ type: 'sync-applied', applied: false })).toEqual({
      type: 'sync-applied',
      applied: false,
    });

    // Not a UUID: rejected before it can reach store matching.
    expect(
      agentRequestSchema.safeParse({ type: 'sync-pull', syncId: '../etc', role: 'owner' }).success,
    ).toBe(false);
    // An oversized payload is rejected by the bundle size cap.
    const huge = { blob: 'x'.repeat(65 * 1024) };
    expect(
      agentRequestSchema.safeParse({
        type: 'sync-push',
        syncId,
        role: 'owner',
        bundle: { ...bundle, payload: huge },
      }).success,
    ).toBe(false);
  });
});
