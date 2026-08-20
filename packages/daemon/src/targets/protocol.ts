/**
 * Private stdio protocol between an SSH transport and the remote apm agent.
 * Dynamic process values are JSON fields, never parts of the SSH command.
 */
import { z } from 'zod';
import {
  TARGET_SIGNALS,
  TRANSPORT_ERROR_CODES,
  commandSpecSchema,
  credentialBundleSchema,
  profileIdSchema,
  providerIdSchema,
  type CommandSpec,
  type CommandResult,
  type CredentialBundle,
  type ExecOptions,
  type ExitStatus,
  type ProfileSync,
  type PtySpec,
  type TargetProfileSummary,
  type TransportErrorCode,
} from '@apm/shared';

const execOptionsSchema = z.object({
  stdin: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
});

const ptySpecSchema = commandSpecSchema.extend({
  cols: z.number().int().min(2).max(1000),
  rows: z.number().int().min(2).max(500),
  term: z.string().min(1).optional(),
});

export const agentRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('probe') }),
  z.object({ type: z.literal('profiles') }),
  z.object({ type: z.literal('exec'), spec: commandSpecSchema, options: execOptionsSchema }),
  z.object({ type: z.literal('pty'), spec: ptySpecSchema }),
  z.object({ type: z.literal('input'), data: z.string() }),
  z.object({
    type: z.literal('resize'),
    cols: z.number().int().min(2).max(1000),
    rows: z.number().int().min(2).max(500),
  }),
  z.object({ type: z.literal('signal'), signal: z.enum(TARGET_SIGNALS) }),
  z.object({ type: z.literal('close') }),
  z.object({
    type: z.literal('sync-pull'),
    syncId: z.string().uuid(),
    role: z.enum(['owner', 'replica']),
  }),
  z.object({
    type: z.literal('sync-push'),
    syncId: z.string().uuid(),
    role: z.enum(['owner', 'replica']),
    bundle: credentialBundleSchema,
  }),
]);

export type AgentRequest =
  | { type: 'probe' }
  | { type: 'profiles' }
  | { type: 'exec'; spec: CommandSpec; options: ExecOptions }
  | { type: 'pty'; spec: PtySpec }
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'signal'; signal: (typeof TARGET_SIGNALS)[number] }
  | { type: 'close' }
  | { type: 'sync-pull'; syncId: string; role: ProfileSync['role'] }
  | { type: 'sync-push'; syncId: string; role: ProfileSync['role']; bundle: CredentialBundle };

export type AgentResponse =
  | { type: 'ready'; handleId?: string }
  | { type: 'profiles'; profiles: TargetProfileSummary[] }
  | { type: 'result'; result: CommandResult }
  | { type: 'data'; data: string }
  | ({ type: 'exit' } & ExitStatus)
  | { type: 'error'; code: TransportErrorCode; message: string }
  | { type: 'sync-bundle'; bundle: CredentialBundle }
  | { type: 'sync-applied'; applied: boolean };

const targetProfileSchema = z.object({
  id: profileIdSchema,
  provider: providerIdSchema,
  label: z.string(),
  status: z.enum(['pending', 'active', 'error']),
  enabled: z.boolean(),
});

const knownProviderEntrySchema = z.object({ provider: providerIdSchema });

/**
 * A newer remote apm may list profiles of a provider this build does not know.
 * Only those entries are dropped, so the rest of the target stays reachable.
 * An entry of a known provider that does not parse is real corruption and
 * fails the whole response, as it did before.
 */
const targetProfilesSchema = z.array(z.unknown()).transform((entries, ctx) => {
  const profiles: TargetProfileSummary[] = [];
  for (const entry of entries) {
    const parsed = targetProfileSchema.safeParse(entry);
    if (parsed.success) {
      profiles.push(parsed.data);
      continue;
    }
    if (knownProviderEntrySchema.safeParse(entry).success) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Malformed profile entry' });
      return z.NEVER;
    }
  }
  return profiles;
});

export const agentResponseSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), handleId: z.string().optional() }),
  z.object({
    type: z.literal('profiles'),
    profiles: targetProfilesSchema,
  }),
  z.object({
    type: z.literal('result'),
    result: z.object({
      exitCode: z.number().int().nullable(),
      signal: z.string().nullable(),
      stdout: z.string(),
      stderr: z.string(),
    }),
  }),
  z.object({ type: z.literal('data'), data: z.string() }),
  z.object({
    type: z.literal('exit'),
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
  }),
  z.object({
    type: z.literal('error'),
    code: z.enum(TRANSPORT_ERROR_CODES),
    message: z.string(),
  }),
  z.object({ type: z.literal('sync-bundle'), bundle: credentialBundleSchema }),
  z.object({ type: z.literal('sync-applied'), applied: z.boolean() }),
]);

export function encodeAgentMessage(message: AgentRequest | AgentResponse): string {
  return `${JSON.stringify(message)}\n`;
}
