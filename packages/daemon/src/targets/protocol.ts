/**
 * Private stdio protocol between an SSH transport and the remote apm agent.
 * Dynamic process values are JSON fields, never parts of the SSH command.
 */
import { z } from 'zod';
import {
  TARGET_SIGNALS,
  TRANSPORT_ERROR_CODES,
  commandSpecSchema,
  profileIdSchema,
  providerIdSchema,
  type CommandSpec,
  type CommandResult,
  type DetachedServiceSpec,
  type DetachedServiceState,
  type ExecOptions,
  type ExitStatus,
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

const detachedSpecSchema = commandSpecSchema.extend({
  instanceId: z.string().min(1),
  port: z.number().int().min(1).max(65_535),
  baseDir: z.string().min(1),
});

/** Only opaque ids, pids and ports cross for a detached service — never more. */
const detachedStateSchema = z.object({
  instanceId: z.string().min(1),
  pid: z.number().int().positive(),
  port: z.number().int(),
  startedAt: z.string(),
});

const detachedRef = {
  instanceId: z.string().min(1),
  baseDir: z.string().min(1),
};

export const agentRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('probe') }),
  z.object({ type: z.literal('profiles') }),
  z.object({ type: z.literal('exec'), spec: commandSpecSchema, options: execOptionsSchema }),
  z.object({ type: z.literal('pty'), spec: ptySpecSchema }),
  // Detached managed services (T3): spawn survives the agent, inspect/stop
  // find the process again by its target-side record.
  z.object({ type: z.literal('detached-spawn'), spec: detachedSpecSchema }),
  z.object({ type: z.literal('detached-inspect'), ...detachedRef }),
  z.object({ type: z.literal('detached-stop'), ...detachedRef }),
  z.object({ type: z.literal('input'), data: z.string() }),
  z.object({
    type: z.literal('resize'),
    cols: z.number().int().min(2).max(1000),
    rows: z.number().int().min(2).max(500),
  }),
  z.object({ type: z.literal('signal'), signal: z.enum(TARGET_SIGNALS) }),
  z.object({ type: z.literal('close') }),
]);

export type AgentRequest =
  | { type: 'probe' }
  | { type: 'profiles' }
  | { type: 'exec'; spec: CommandSpec; options: ExecOptions }
  | { type: 'pty'; spec: PtySpec }
  | { type: 'detached-spawn'; spec: DetachedServiceSpec }
  | { type: 'detached-inspect'; instanceId: string; baseDir: string }
  | { type: 'detached-stop'; instanceId: string; baseDir: string }
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'signal'; signal: (typeof TARGET_SIGNALS)[number] }
  | { type: 'close' };

export type AgentResponse =
  | { type: 'ready'; handleId?: string }
  | { type: 'profiles'; profiles: TargetProfileSummary[] }
  | { type: 'result'; result: CommandResult }
  | { type: 'detached'; state: DetachedServiceState | null; reason: string | null }
  | { type: 'data'; data: string }
  | ({ type: 'exit' } & ExitStatus)
  | { type: 'error'; code: TransportErrorCode; message: string };

export const agentResponseSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), handleId: z.string().optional() }),
  z.object({
    type: z.literal('profiles'),
    profiles: z.array(
      z.object({
        id: profileIdSchema,
        provider: providerIdSchema,
        label: z.string(),
        status: z.enum(['pending', 'active', 'error']),
        enabled: z.boolean(),
      }),
    ),
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
  z.object({
    type: z.literal('detached'),
    state: detachedStateSchema.nullable(),
    reason: z.string().nullable(),
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
]);

export function encodeAgentMessage(message: AgentRequest | AgentResponse): string {
  return `${JSON.stringify(message)}\n`;
}
