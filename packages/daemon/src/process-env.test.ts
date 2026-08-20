import { afterEach, describe, expect, it } from 'vitest';
import { childProcessEnv } from './process-env.js';

const original = process.env.CURSOR_API_KEY;

afterEach(() => {
  if (original === undefined) delete process.env.CURSOR_API_KEY;
  else process.env.CURSOR_API_KEY = original;
});

describe('childProcessEnv', () => {
  it('drops inherited CURSOR_API_KEY when a Cursor home is bound', () => {
    process.env.CURSOR_API_KEY = 'inherited-secret';
    const env = childProcessEnv({
      CURSOR_CONFIG_DIR: '/tmp/cursor-home',
      AGENT_CLI_CREDENTIAL_STORE: 'file',
    });
    expect(env.CURSOR_CONFIG_DIR).toBe('/tmp/cursor-home');
    expect(env.AGENT_CLI_CREDENTIAL_STORE).toBe('file');
    expect(Object.hasOwn(env, 'CURSOR_API_KEY')).toBe(false);
  });

  it('drops CURSOR_API_KEY even when extra env tries to set it', () => {
    process.env.CURSOR_API_KEY = 'inherited-secret';
    const env = childProcessEnv(
      { CURSOR_CONFIG_DIR: '/tmp/cursor-home' },
      { CURSOR_API_KEY: 'from-spec' },
    );
    expect(Object.hasOwn(env, 'CURSOR_API_KEY')).toBe(false);
  });

  it('leaves CURSOR_API_KEY alone for other providers', () => {
    process.env.CURSOR_API_KEY = 'inherited-secret';
    const env = childProcessEnv({ CLAUDE_CONFIG_DIR: '/tmp/claude-home' });
    expect(env.CURSOR_API_KEY).toBe('inherited-secret');
    expect(env.CLAUDE_CONFIG_DIR).toBe('/tmp/claude-home');
  });
});
