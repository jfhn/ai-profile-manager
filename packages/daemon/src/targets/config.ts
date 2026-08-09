/**
 * Approved remote targets live in one human-editable file. Invalid files fail
 * daemon startup instead of silently widening or changing the approved set.
 */
import fs from 'node:fs';
import { z } from 'zod';
import { LOCAL_TARGET_ID, targetIdSchema, type TargetTransport } from '@apm/shared';
import type { DaemonConfig } from '../config.js';
import { createSshTransport } from './ssh.js';

const sshTargetSchema = z
  .object({
    id: targetIdSchema.refine((id) => id !== LOCAL_TARGET_ID, {
      message: `"${LOCAL_TARGET_ID}" is reserved for this machine`,
    }),
    label: z.string().trim().min(1).max(64),
    transport: z.literal('ssh'),
    address: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .regex(/^[^-\s][^\s]*$/, 'SSH addresses cannot start with - or contain whitespace'),
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
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'file'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid target config ${config.targetsFile}: ${details}`);
  }
  return parsed.data.targets;
}

export function createConfiguredTransports(
  config: Pick<DaemonConfig, 'targetsFile'>,
): TargetTransport[] {
  return readConfiguredTargets(config).map((target) => createSshTransport(target));
}
