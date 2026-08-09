/**
 * Approved remote targets live in one human-editable file. Invalid files fail
 * daemon startup instead of silently widening or changing the approved set.
 *
 * The file stays the store when the dashboard approves or revokes a machine:
 * the same schema validates every write, and a write replaces the file
 * atomically so a crash mid-write can never leave a half-approved set behind.
 */
import fs from 'node:fs';
import { z } from 'zod';
import { remoteTargetIdSchema, targetAddressSchema, type TargetTransport } from '@apm/shared';
import type { DaemonConfig } from '../config.js';
import { createSshTransport } from './ssh.js';

const sshTargetSchema = z
  .object({
    id: remoteTargetIdSchema,
    label: z.string().trim().min(1).max(64),
    transport: z.literal('ssh'),
    address: targetAddressSchema,
    approved: z.boolean(),
  })
  .strict();

const targetFileSchema = z
  .object({
    version: z.literal(1),
    targets: z.array(sshTargetSchema),
  })
  .strict()
  .superRefine(({ targets }, ctx) => {
    const seen = new Set<string>();
    for (const [index, target] of targets.entries()) {
      if (seen.has(target.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['targets', index, 'id'],
          message: `duplicate target id "${target.id}"`,
        });
      }
      seen.add(target.id);
    }
  });

export type ConfiguredTarget = z.infer<typeof sshTargetSchema>;

export function readConfiguredTargets(
  config: Pick<DaemonConfig, 'targetsFile'>,
): ConfiguredTarget[] {
  let raw: string;
  try {
    raw = fs.readFileSync(config.targetsFile, 'utf8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in ${config.targetsFile}`);
  }
  const parsed = targetFileSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid target config ${config.targetsFile}: ${describeIssues(parsed.error)}`);
  }
  return parsed.data.targets;
}

/**
 * Replace the target file with exactly these entries.
 *
 * The set is validated against the very same schema the daemon reads with, so
 * a mutation can never write a file that would fail the next startup, and the
 * replacement is a rename over a private temporary file: readers see either
 * the old approved set or the new one, never a truncated one.
 */
export function writeConfiguredTargets(
  config: Pick<DaemonConfig, 'targetsFile'>,
  targets: ConfiguredTarget[],
): void {
  const parsed = targetFileSchema.safeParse({ version: 1, targets });
  if (!parsed.success) {
    throw new Error(`Refusing to write an invalid target config: ${describeIssues(parsed.error)}`);
  }
  const temporary = `${config.targetsFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(parsed.data, null, 2) + '\n', { mode: 0o600 });
  try {
    fs.renameSync(temporary, config.targetsFile);
  } catch (error: unknown) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || 'file'}: ${issue.message}`)
    .join('; ');
}

export function createConfiguredTransports(
  config: Pick<DaemonConfig, 'targetsFile'>,
): TargetTransport[] {
  return readConfiguredTargets(config).map((target) => createSshTransport(target));
}
