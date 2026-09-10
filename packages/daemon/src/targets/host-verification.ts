import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExecutionTarget, SshHostVerification } from '@apm/shared';
import { ApiFailure } from '../context.js';

interface Challenge {
  targetId: string;
  address: string;
  directory: string;
  done: Promise<boolean>;
  stop: () => void;
  answered: boolean;
}

// OpenSSH invokes this once for the key on its live connection. No password or
// private-key passphrase questions may reach the browser or receive an answer.
const ASKPASS = `
const fs = require('node:fs');
const path = require('node:path');
const directory = process.argv[1];
const prompt = process.argv[2] || '';
if (!prompt.includes('SHA256:') || !prompt.includes('Are you sure you want to continue connecting')) process.exit(1);
fs.writeFileSync(path.join(directory, 'asked'), '', { flag: 'wx', mode: 0o600 });
fs.writeFileSync(path.join(directory, 'question.tmp'), prompt, { flag: 'wx', mode: 0o600 });
fs.renameSync(path.join(directory, 'question.tmp'), path.join(directory, 'question'));
const wait = new Int32Array(new SharedArrayBuffer(4));
for (let i = 0; i < 1200; i++) {
  try {
    const answer = fs.readFileSync(path.join(directory, 'answer'), 'utf8');
    process.stdout.write(answer === 'yes' ? 'yes\\n' : 'no\\n');
    process.exit(0);
  } catch (error) { if (error.code !== 'ENOENT') process.exit(1); }
  Atomics.wait(wait, 0, 0, 100);
}
process.exit(1);
`;

export function createHostVerification() {
  const challenges = new Map<string, Challenge>();

  return {
    async begin(target: ExecutionTarget): Promise<SshHostVerification> {
      const address = target.identity.address;
      if (
        process.platform === 'win32' ||
        !target.approved ||
        target.kind !== 'remote' ||
        target.transport !== 'ssh' ||
        !address
      ) {
        throw new ApiFailure(
          400,
          'host-verification-unavailable',
          `SSH verification is unavailable for target "${target.id}"`,
        );
      }
      if (challenges.size >= 16 || [...challenges.values()].some((c) => c.targetId === target.id)) {
        throw new ApiFailure(
          409,
          'host-verification-busy',
          `SSH verification is already pending for target "${target.id}"`,
        );
      }
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apm-ssh-'));
      const helper = path.join(directory, 'askpass');
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
      fs.writeFileSync(
        helper,
        `#!/bin/sh\nexec ${quote(process.execPath)} -e ${quote(ASKPASS)} ${quote(directory)} "$@"\n`,
        { mode: 0o700 },
      );
      const challengeId = crypto.randomUUID();
      const child = spawn(
        'ssh',
        [
          '-T',
          '-o',
          'BatchMode=no',
          '-o',
          'StrictHostKeyChecking=ask',
          '-o',
          'PasswordAuthentication=no',
          '-o',
          'KbdInteractiveAuthentication=no',
          '-o',
          'ConnectTimeout=10',
          '--',
          address,
          'true',
        ],
        {
          detached: true,
          stdio: ['ignore', 'ignore', 'pipe'],
          env: {
            ...process.env,
            LC_ALL: 'C',
            SSH_ASKPASS: helper,
            SSH_ASKPASS_REQUIRE: 'force',
            DISPLAY: ':0',
          },
        },
      );
      child.stderr.resume();
      const stop = () => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch {
          return;
        }
      };
      child.once('exit', stop);
      let exited = false;
      const done = new Promise<boolean>((resolve) => {
        const timeout = setTimeout(stop, 120_000);
        const finish = (success: boolean) => {
          if (exited) return;
          exited = true;
          clearTimeout(timeout);
          challenges.delete(challengeId);
          fs.rmSync(directory, { recursive: true, force: true });
          resolve(success);
        };
        child.once('error', () => finish(false));
        child.once('close', (code) => finish(code === 0));
      });
      challenges.set(challengeId, {
        targetId: target.id,
        address,
        directory,
        done,
        stop,
        answered: false,
      });
      while (!exited) {
        try {
          const prompt = fs.readFileSync(path.join(directory, 'question'), 'utf8');
          return { state: 'confirmation', challengeId, address, prompt };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            stop();
            throw error;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (await done) return { state: 'verified' };
      throw new ApiFailure(
        409,
        'host-verification-failed',
        `SSH verification failed for target "${target.id}"`,
      );
    },

    async confirm(target: ExecutionTarget, challengeId: string, accept: boolean): Promise<void> {
      const challenge = challenges.get(challengeId);
      if (
        !challenge ||
        challenge.answered ||
        challenge.targetId !== target.id ||
        challenge.address !== target.identity.address ||
        !target.approved
      ) {
        throw new ApiFailure(
          409,
          'host-verification-expired',
          `SSH confirmation expired for target "${target.id}"`,
        );
      }
      // Consume before awaiting: a confirmation cannot be submitted twice.
      challenge.answered = true;
      if (!accept) {
        challenge.stop();
        await challenge.done;
        return;
      }
      fs.writeFileSync(path.join(challenge.directory, 'answer.tmp'), 'yes', {
        mode: 0o600,
        flag: 'wx',
      });
      fs.renameSync(
        path.join(challenge.directory, 'answer.tmp'),
        path.join(challenge.directory, 'answer'),
      );
      if (!(await challenge.done)) {
        throw new ApiFailure(
          409,
          'host-verification-failed',
          `SSH verification failed for target "${target.id}"`,
        );
      }
    },

    async close() {
      const pending = [...challenges.values()];
      for (const challenge of challenges.values()) challenge.stop();
      await Promise.all(pending.map((challenge) => challenge.done));
    },
  };
}
