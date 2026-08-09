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
        profileId: 'profile-1',
        cols: 120,
        rows: 40,
      },
    };

    const encoded = encodeAgentMessage(request);
    expect(encoded.endsWith('\n')).toBe(true);
    expect(agentRequestSchema.parse(JSON.parse(encoded))).toEqual(request);
  });
});
