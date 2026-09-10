import { afterEach, expect, it, vi } from 'vitest';
import { profileCommand } from './commands.js';
import { apiRequest } from './daemon-client.js';
import { verifySshHost } from '../targets/ssh.js';

vi.mock('./daemon-client.js', () => ({
  daemonOrStart: vi.fn(async () => ({})),
  apiRequest: vi.fn(),
}));
vi.mock('../targets/ssh.js', () => ({ verifySshHost: vi.fn() }));

const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
const stderrTTY = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
const exitCode = process.exitCode;

afterEach(() => {
  if (stdinTTY) Object.defineProperty(process.stdin, 'isTTY', stdinTTY);
  else Reflect.deleteProperty(process.stdin, 'isTTY');
  if (stderrTTY) Object.defineProperty(process.stderr, 'isTTY', stderrTTY);
  else Reflect.deleteProperty(process.stderr, 'isTTY');
  process.exitCode = exitCode;
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

it.each([true, false])(
  'prompts only in interactive terminals (TTY=%s) and retries only the failed target',
  async (interactive) => {
    Object.defineProperty(process.stdin, 'isTTY', { value: interactive, configurable: true });
    Object.defineProperty(process.stderr, 'isTTY', { value: interactive, configurable: true });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const profile = { id: 'source', provider: 'codex', label: 'work' };
    const target = { id: 'server' };
    vi.mocked(apiRequest)
      .mockResolvedValueOnce({ profiles: [profile] })
      .mockResolvedValueOnce({
        profile,
        results: [
          { targetId: 'already-copied', status: 'copied', profile },
          { targetId: 'server', status: 'failed', errorCode: 'host-key-verification-failed' },
        ],
      })
      .mockResolvedValueOnce({ targets: [target] })
      .mockResolvedValueOnce({
        profile,
        results: [{ targetId: 'server', status: 'copied', profile }],
      });
    vi.mocked(verifySshHost).mockResolvedValue(true);

    await profileCommand(['copy', 'codex:work', '--to', 'already-copied', '--to', 'server']);

    if (interactive) {
      expect(verifySshHost).toHaveBeenCalledWith(target);
      expect(apiRequest).toHaveBeenLastCalledWith({}, 'POST', '/api/profiles/source/copy', {
        targetIds: ['server'],
      });
      expect(console.log).toHaveBeenLastCalledWith(
        'copied codex profile "work" to target "server" as "work"',
      );
    } else {
      expect(verifySshHost).not.toHaveBeenCalled();
      expect(apiRequest).toHaveBeenCalledTimes(2);
      expect(process.exitCode).toBe(1);
    }
  },
);
