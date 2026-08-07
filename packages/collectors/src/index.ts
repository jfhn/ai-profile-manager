import type { ProviderId } from '@apm/shared';
import type { ProviderAdapter } from './adapter.js';
import { claudeAdapter } from './adapters/claude.js';
import { codexAdapter } from './adapters/codex.js';

export type { CollectContext, ProviderAdapter } from './adapter.js';

export const adapters: Record<ProviderId, ProviderAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
};

export function getAdapter(provider: ProviderId): ProviderAdapter {
  return adapters[provider];
}
