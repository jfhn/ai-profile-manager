import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createHostVerification } from './host-verification.js';
import { createSshTransport } from './ssh.js';

const settings = vi.hoisted(() => ({ config: '' }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (command: string, args: string[], options: object) =>
      actual.spawn(command, command === 'ssh' ? ['-F', settings.config, ...args] : args, options),
  };
});

const sshd = ['/usr/bin/sshd', '/usr/sbin/sshd'].find((file) => fs.existsSync(file));
let directory: string;
let knownHosts: string;
const verification = createHostVerification();
const target = createSshTransport({
  id: 'test',
  label: 'Test',
  address: 'apm-test',
  approved: true,
}).target;
let server: ChildProcess;

beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-host-test-'));
  knownHosts = path.join(directory, 'known_hosts');
  for (const key of ['host', 'client', 'other']) {
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(directory, key)]);
  }
  const reservation = net.createServer();
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const address = reservation.address() as net.AddressInfo;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const config = path.join(directory, 'sshd_config');
  fs.writeFileSync(
    config,
    `ListenAddress 127.0.0.1\nPort ${address.port}\nHostKey ${directory}/host\nAuthorizedKeysFile ${directory}/client.pub\nStrictModes no\nUsePAM no\nPasswordAuthentication no\nPidFile ${directory}/pid\n`,
  );
  if (!sshd) throw new Error('sshd is required for the SSH verification integration test');
  server = spawn(sshd, ['-D', '-e', '-f', config], { stdio: ['ignore', 'ignore', 'pipe'] });
  await new Promise<void>((resolve, reject) => {
    server.stderr!.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('Server listening')) resolve();
    });
    server.once('exit', () => reject(new Error('Test sshd failed to start')));
    server.once('error', reject);
  });
  settings.config = path.join(directory, 'ssh_config');
  fs.writeFileSync(
    settings.config,
    `Host apm-test\n HostName 127.0.0.1\n Port ${address.port}\n User ${os.userInfo().username}\n IdentityFile ${directory}/client\n IdentitiesOnly yes\n UserKnownHostsFile ${knownHosts}\n GlobalKnownHostsFile /dev/null\n HostKeyAlias apm-test\n`,
  );
});

afterAll(async () => {
  await verification.close();
  if (server && server.exitCode === null) {
    server.kill();
    await new Promise((resolve) => server.once('close', resolve));
  }
  fs.rmSync(directory, { recursive: true, force: true });
});

it.skipIf(!sshd)(
  'cancels without trust, accepts the displayed key, persists trust, and refuses a changed key',
  async () => {
    const first = await verification.begin(target);
    expect(first.state).toBe('confirmation');
    if (first.state !== 'confirmation') throw new Error('Expected a host-key prompt');
    expect(first.prompt).toContain('SHA256:');
    expect(fs.existsSync(knownHosts)).toBe(false);
    await expect(
      verification.confirm({ ...target, id: 'wrong-target' }, first.challengeId, true),
    ).rejects.toMatchObject({ code: 'host-verification-expired' });
    await expect(
      verification.confirm({ ...target, approved: false }, first.challengeId, true),
    ).rejects.toMatchObject({ code: 'host-verification-expired' });
    await verification.confirm(target, first.challengeId, false);
    expect(fs.existsSync(knownHosts)).toBe(false);

    const second = await verification.begin(target);
    if (second.state !== 'confirmation') throw new Error('Expected a host-key prompt');
    const fingerprint = execFileSync('ssh-keygen', ['-lf', path.join(directory, 'host.pub')], {
      encoding: 'utf8',
    }).split(' ')[1];
    expect(second.prompt).toContain(fingerprint);
    await verification.confirm(target, second.challengeId, true);
    expect(fs.readFileSync(knownHosts, 'utf8')).toContain(
      fs.readFileSync(path.join(directory, 'host.pub'), 'utf8').split(' ')[1],
    );
    await expect(verification.begin(target)).resolves.toEqual({ state: 'verified' });
    await expect(verification.confirm(target, second.challengeId, true)).rejects.toMatchObject({
      code: 'host-verification-expired',
    });

    fs.writeFileSync(
      knownHosts,
      `apm-test ${fs.readFileSync(path.join(directory, 'other.pub'), 'utf8')}`,
    );
    const changed = fs.readFileSync(knownHosts, 'utf8');
    await expect(verification.begin(target)).rejects.toMatchObject({
      code: 'host-verification-failed',
    });
    expect(fs.readFileSync(knownHosts, 'utf8')).toBe(changed);
  },
  15_000,
);
