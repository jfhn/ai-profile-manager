import { z } from 'zod';
import { PROVIDER_IDS } from './provider.js';
import { LOCAL_TARGET_ID, TARGET_CAPABILITIES } from './target.js';

/**
 * Zod schemas for API request validation (daemon-side) and persisted state.
 * The web app must import types only (`import type`) to keep zod out of the
 * bundle.
 */

export const providerIdSchema = z.enum(PROVIDER_IDS);

const label = z.string().trim().min(1).max(64);
const nonBlankString = z.string().refine((value) => value.trim().length > 0, {
  message: 'must not be blank',
});

/**
 * Stable profile ids are opaque values. Preserve their exact spelling and do
 * not narrow them to path- or shell-safe characters: consumers may only
 * validate this transport/storage bound.
 */
export const PROFILE_ID_MAX_UTF8_BYTES = 256;
export const profileIdSchema = nonBlankString
  .refine((value) => !/\p{Cc}/u.test(value), {
    message: 'profile ids must not contain Unicode control characters',
  })
  .refine((value) => utf8ByteLength(value) <= PROFILE_ID_MAX_UTF8_BYTES, {
    message: `profile ids must not exceed ${PROFILE_ID_MAX_UTF8_BYTES} UTF-8 bytes`,
  });

const isoTimestamp = z.string().datetime({ offset: true });
const nullablePercent = z.number().finite().min(0).max(100).nullable();

export const usageWindowSchema = z.object({
  id: nonBlankString,
  label: nonBlankString,
  usedPercent: nullablePercent,
  remainingPercent: nullablePercent,
  resetAt: isoTimestamp.nullable(),
});

/** Complete persisted/API usage shape. Historical SQLite rows are untrusted. */
export const usageSnapshotSchema = z.object({
  profileId: profileIdSchema,
  windows: z.array(usageWindowSchema),
  fetchedAt: isoTimestamp,
  source: nonBlankString,
  cacheStatus: z.enum(['live', 'cache', 'stale-cache', 'cooldown', 'error']),
  dataUpdatedAt: isoTimestamp.nullable(),
  stale: z.boolean(),
  staleReason: z.string().nullable(),
  failureKind: z.enum(['auth', 'timeout', 'rate-limited', 'error']).nullable(),
  error: z.string().nullable(),
  planType: z.string().nullable(),
  retryAfterSeconds: z.number().finite().nonnegative().nullable(),
});

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

export const updateDefaultProfileRequestSchema = z.object({
  profileId: profileIdSchema.nullable(),
});

export const startWizardRequestSchema = z.object({
  provider: providerIdSchema,
});

export const confirmWizardRequestSchema = z.object({
  label,
});

export const createSessionRequestSchema = z.object({
  targetId: targetIdSchema.optional(),
  profileId: profileIdSchema,
  app: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().min(1).optional(),
  lifecycle: z.enum(['persistent', 'connection-bound']).default('persistent'),
  cols: z.number().int().min(2).max(1000).default(80),
  rows: z.number().int().min(2).max(500).default(24),
});

export const createT3InstanceRequestSchema = z.object({
  label,
  profiles: z
    .record(providerIdSchema, profileIdSchema)
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
  profileIds: z.array(profileIdSchema).optional(),
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
  id: profileIdSchema,
  provider: providerIdSchema,
  label,
  home: z.string().min(1).refine(isPortableAbsolutePath, {
    message: 'profile homes must be absolute paths',
  }),
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

const persistedProfilesSchema = z.array(profileSchema).superRefine(assertUniqueProfileIds);

export const profileStoreFileV1Schema = z.object({
  version: z.literal(1),
  profiles: persistedProfilesSchema,
});

export const defaultProfileIdsSchema = z
  .object({
    claude: profileIdSchema.optional(),
    codex: profileIdSchema.optional(),
  })
  .strict();

export const profileStoreFileV2Schema = z.object({
  version: z.literal(2),
  profiles: persistedProfilesSchema,
  defaultProfileIds: defaultProfileIdsSchema.optional().default({}),
});

export const profileStoreFileSchema = z.union([profileStoreFileV1Schema, profileStoreFileV2Schema]);

/** Runtime form of the stable `apm profiles --json` version-1 contract. */
export const profilesCliResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    defaultProfileIds: defaultProfileIdsSchema,
    profiles: z
      .array(
        z
          .object({
            id: profileIdSchema,
            provider: providerIdSchema,
            label: nonBlankString,
            home: z.string().min(1).refine(isPortableAbsolutePath, {
              message: 'profile homes must be absolute paths',
            }),
            status: z.enum(['pending', 'active', 'error']),
            enabled: z.boolean(),
            usage: usageSnapshotSchema.nullable(),
          })
          .strict(),
      )
      .superRefine(assertUniqueProfileIds),
  })
  .strict();

const targetProfileSummarySchema = z
  .object({
    id: profileIdSchema,
    provider: providerIdSchema,
    label: nonBlankString,
    status: z.enum(['pending', 'active', 'error']),
    enabled: z.boolean(),
  })
  .strict();

const targetIdentitySchema = z
  .object({
    hostname: z.string().nullable(),
    address: z.string().nullable(),
    fingerprint: z.string().nullable(),
  })
  .strict();

const executionTargetSchema = z
  .object({
    id: targetIdSchema,
    label: nonBlankString,
    kind: z.enum(['local', 'remote']),
    transport: nonBlankString,
    identity: targetIdentitySchema,
    capabilities: z.array(z.enum(TARGET_CAPABILITIES)),
    approved: z.boolean(),
    status: z.enum(['online', 'offline', 'unknown']),
  })
  .strict();

/**
 * Producer-side assertion for APM's own `apm targets --json` output.
 *
 * This deliberately rejects capabilities unknown to this APM build so its
 * emitted values cannot drift from `TARGET_CAPABILITIES`. Integrations must
 * treat capability names as open strings and ignore names they do not know.
 */
export const targetsCliProducerSchema = z
  .object({
    schemaVersion: z.literal(1),
    targets: z.array(executionTargetSchema),
  })
  .strict();

/** Runtime form of the stable target-scoped profile contract. */
export const targetProfilesCliResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    targetId: targetIdSchema,
    profiles: z.array(targetProfileSummarySchema).superRefine(assertUniqueProfileIds),
  })
  .strict();

function assertUniqueProfileIds<T extends { id: string }>(
  profiles: T[],
  context: z.RefinementCtx,
): void {
  const firstIndexById = new Map<string, number>();
  for (const [index, profile] of profiles.entries()) {
    const firstIndex = firstIndexById.get(profile.id);
    if (firstIndex === undefined) {
      firstIndexById.set(profile.id, index);
      continue;
    }
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: [index, 'id'],
      message: `profiles[${index}].id duplicates profiles[${firstIndex}].id (${JSON.stringify(profile.id)})`,
    });
  }
}

function isPortableAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}
