import os from 'node:os';
import path from 'node:path';
import type { CollectResult } from '@apm/shared';
import type { CollectContext, ProviderAdapter } from '../adapter.js';

// STUB — replaced by the real implementation (ported from the noctalia
// ai-usage-collector). Kept minimal so dependents compile.
export const claudeAdapter: ProviderAdapter = {
  provider: 'claude',
  displayName: 'Claude Code',
  capabilities: {
    usage: true,
    usageSources: ['local-files', 'oauth-api'],
    identity: true,
    windows: ['five_hour', 'weekly'],
    notes: 'OAuth usage endpoint is undocumented and treated as a maintenance risk.',
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
    error: 'claude adapter not implemented yet',
    planType: null,
    retryAfterSeconds: null,
  }),
  env: (home) => ({ CLAUDE_CONFIG_DIR: home }),
  loginCommand: (home) => `CLAUDE_CONFIG_DIR=${home} claude`,
  defaultHome: () => path.join(os.homedir(), '.claude'),
};
