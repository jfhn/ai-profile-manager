import { z } from 'zod';
import { PROVIDER_IDS } from './provider.js';
import { LOCAL_TARGET_ID } from './target.js';

/**
 * Zod schemas for API request validation (daemon-side) and persisted state.
 * The web app must import types only (`import type`) to keep zod out of the
 * bundle.
 */

export const providerIdSchema = z.enum(PROVIDER_IDS);

const label = z.string().trim().min(1).max(64);

/** Target selection is always an id, never an ad-hoc host string. */
export const targetIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/i, 'target ids are alphanumeric with . _ -');

/** A remote machine's id — the local target's id is reserved for this machine. */
export const remoteTargetIdSchema = targetIdSchema.refine((id) => id !== LOCAL_TARGET_ID, {
  message: `"${LOCAL_TARGET_ID}" is reserved for this machine`,
});

/**
 * A transport-level address (tailnet name, ssh host). It is handed to a
 * transport as a structured value, and the leading-dash ban keeps it from ever
 * reading as an option should it end up next to one.
 */
export const targetAddressSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[^-\s][^\s]*$/, 'SSH addresses cannot start with - or contain whitespace');

/** POST /api/targets — approving one discovered machine as an execution target. */
export const addTargetRequestSchema = z
  .object({
    id: remoteTargetIdSchema,
    label,
    address: targetAddressSchema,
  })
  .strict();

export const createProfileRequestSchema = z.object({
  provider: providerIdSchema,
  label,
  home: z.string().min(1),
});

export const updateProfileRequestSchema = z
  .object({
    label: label.optional(),
    enabled: z.boolean().optional(),
  })
  .refine((v) => v.label !== undefined || v.enabled !== undefined, {
    message: 'nothing to update',
  });

export const startWizardRequestSchema = z.object({
  provider: providerIdSchema,
});

export const confirmWizardRequestSchema = z.object({
  label,
});

export const createSessionRequestSchema = z.object({
  targetId: targetIdSchema.optional(),
  profileId: z.string().min(1),
  app: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().min(1).optional(),
  cols: z.number().int().min(2).max(1000).default(80),
  rows: z.number().int().min(2).max(500).default(24),
});

export const createT3InstanceRequestSchema = z.object({
  label,
  profiles: z
    .record(providerIdSchema, z.string().min(1))
    .refine((v) => Object.keys(v).length > 0, { message: 'at least one profile required' }),
  // Omitted means the local target, so an existing client keeps working.
  targetId: targetIdSchema.optional(),
});

/**
 * A command as it crosses the transport seam: argv + env + cwd, so a request
 * can never smuggle in a shell string.
 */
export const commandSpecSchema = z.object({
  argv: z.array(z.string().min(1)).min(1),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().min(1).optional(),
  profileId: z.string().min(1).optional(),
});

export const terminalClientMessageSchema = z.union([
  z.object({ type: z.literal('input'), data: z.string() }),
  z.object({
    type: z.literal('resize'),
    cols: z.number().int().min(2).max(1000),
    rows: z.number().int().min(2).max(500),
  }),
]);

/** Persisted profile store shape (profiles.json). */
export const profileSchema = z.object({
  id: z.string().min(1),
  provider: providerIdSchema,
  label,
  home: z.string().min(1),
  homeKind: z.enum(['managed', 'external']),
  identity: z
    .object({
      account: z.string().nullable(),
      organization: z.string().nullable(),
      plan: z.string().nullable(),
    })
    .nullable(),
  status: z.enum(['pending', 'active', 'error']),
  statusReason: z.string().nullable(),
  enabled: z.boolean(),
  createdAt: z.string(),
});

export const profileStoreFileSchema = z.object({
  version: z.literal(1),
  profiles: z.array(profileSchema),
});
