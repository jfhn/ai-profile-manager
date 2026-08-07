import os from 'node:os';
import path from 'node:path';
import type { CollectResult } from '@apm/shared';
import type { CollectContext, ProviderAdapter } from '../adapter.js';

// STUB — replaced by the real implementation (ported from the noctalia
// ai-usage-collector). Kept minimal so dependents compile.
export const codexAdapter: ProviderAdapter = {
  provider: 'codex',
  displayName: 'Codex',
  capabilities: {
    usage: true,
    usageSources: ['local-files'],
    identity: true,
    windows: ['five_hour', 'weekly'],
    notes: 'Usage is read from session rate_limit events; appears after Codex records usage.',
  },
  hasCredentials: () => false,
  detectIdentity: () => null,
  collectUsage: async (_ctx: CollectContext): Promise<CollectResult> => ({
    windows: [],
    source: 'stub',
    cacheStatus: 'error',
    dataUpdatedAt: null,
    stale: true,
    staleReason: null,
    failureKind: 'error',
    error: 'codex adapter not implemented yet',
    planType: null,
    retryAfterSeconds: null,
  }),
  env: (home) => ({ CODEX_HOME: home }),
  loginCommand: (home) => `CODEX_HOME=${home} codex login`,
  defaultHome: () => path.join(os.homedir(), '.codex'),
};
