import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { createSshTransport, verifySshHost } from './ssh.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

const target = {
  id: 'server',
  label: 'Server',
  address: 'server.tailnet.ts.net',
  approved: true,
};

beforeEach(() => vi.resetAllMocks());

it('reports host verification failures, lets OpenSSH confirm, then reaches the agent', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  const transport = createSshTransport(target);
  const failed = transport.profiles();
  child.stderr.write('Host key verification failed.\n');
  child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
  child.emit('close', 255);
  await expect(failed).rejects.toMatchObject({ code: 'host-key-verification-failed' });

  const verified = verifySshHost(transport.target);
  expect(spawn).toHaveBeenLastCalledWith(
    'ssh',
    expect.arrayContaining([
      'StrictHostKeyChecking=ask',
      'PasswordAuthentication=no',
      'KbdInteractiveAuthentication=no',
      '--',
      target.address,
      'true',
    ]),
    { shell: false, stdio: 'inherit' },
  );
  child.emit('close', 0);
  await expect(verified).resolves.toBe(true);

  const next = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  vi.mocked(spawn).mockReturnValue(next as unknown as ReturnType<typeof spawn>);
  const profiles = transport.profiles();
  next.stdout.write('{"type":"profiles","profiles":[]}\n');
  await expect(profiles).resolves.toEqual([]);
});

it('leaves rejected verification unsuccessful and refuses unapproved targets', async () => {
  const child = new EventEmitter();
  vi.mocked(spawn).mockReturnValue(child as ReturnType<typeof spawn>);
  const transport = createSshTransport(target);
  const verification = verifySshHost(transport.target);
  child.emit('close', 255);
  await expect(verification).resolves.toBe(false);
  await expect(verifySshHost({ ...transport.target, approved: false })).rejects.toThrow('server');
  expect(spawn).toHaveBeenCalledTimes(1);
});
