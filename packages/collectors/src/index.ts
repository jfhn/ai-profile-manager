import type { ProviderId } from '@apm/shared';
import type { ProviderAdapter } from './adapter.js';
import { claudeAdapter } from './adapters/claude.js';
import { codexAdapter } from './adapters/codex.js';
import { cursorAdapter } from './adapters/cursor.js';

export type { CollectContext, CredentialSyncSupport, ProviderAdapter } from './adapter.js';
export { createCredentialSync, stablePayloadKey } from './credential-sync.js';

export const adapters: Record<ProviderId, ProviderAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  cursor: cursorAdapter,
};

export function getAdapter(provider: ProviderId): ProviderAdapter {
  return adapters[provider];
}
