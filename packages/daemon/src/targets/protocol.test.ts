import { describe, expect, it } from 'vitest';
import { agentRequestSchema, encodeAgentMessage, type AgentRequest } from './protocol.js';

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
        argv: ['t3', 'serve', '--port', '4800', '--base-dir', '/home/dev/.local/share/apm/t3/a'],
        cwd: '/home/dev/.local/share/apm/t3/a',
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

  it('rejects a blank profile id instead of forwarding it to the target', () => {
    const spec = {
      argv: ['t3'],
      profileIds: ['claude-remote', '  '],
      cols: 80,
      rows: 24,
    };
    expect(agentRequestSchema.safeParse({ type: 'pty', spec }).success).toBe(false);
  });

  it('round-trips the detached verbs with ids, ports and paths only', () => {
    const spawn: AgentRequest = {
      type: 'detached-spawn',
      spec: {
        argv: ['t3', 'serve', '--port', '4800', '--base-dir', '/home/dev/.local/share/apm/t3/a'],
        cwd: '/home/dev/.local/share/apm/t3/a',
        env: { APM_MANAGED_T3_INSTANCE_ID: 'a' },
        profileIds: ['claude-remote'],
        instanceId: 'a',
        port: 4800,
        baseDir: '/home/dev/.local/share/apm/t3/a',
      },
    };
    expect(agentRequestSchema.parse(JSON.parse(encodeAgentMessage(spawn)))).toEqual(spawn);

    for (const type of ['detached-inspect', 'detached-stop'] as const) {
      const request: AgentRequest = {
        type,
        instanceId: 'a',
        baseDir: '/home/dev/.local/share/apm/t3/a',
      };
      expect(agentRequestSchema.parse(JSON.parse(encodeAgentMessage(request)))).toEqual(request);
    }
    // No verb without its base dir: the record is scoped to the instance dir.
    expect(
      agentRequestSchema.safeParse({ type: 'detached-stop', instanceId: 'a' }).success,
    ).toBe(false);
  });
});
