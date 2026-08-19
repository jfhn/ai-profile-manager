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
});
