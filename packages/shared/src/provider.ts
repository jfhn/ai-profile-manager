/**
 * Provider-level types. A "provider" is an AI vendor whose CLI/account the
 * daemon manages profiles for. Provider-specific behavior lives in adapters
 * (packages/collectors); everything here is provider-agnostic shape.
 */

export const PROVIDER_IDS = ['claude', 'codex', 'cursor'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/**
 * Apps whose provider is known. `apm run` scopes the profile lookup to that
 * provider, and the session host refuses to spawn one under a profile of a
 * different provider. Anything absent here is an arbitrary command and binds
 * to whatever profile was named.
 */
export const APP_PROVIDERS: Readonly<Record<string, ProviderId>> = {
  claude: 'claude',
  codex: 'codex',
  'cursor-agent': 'cursor',
};

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value);
}

/** What an adapter can actually do — never pretend all providers expose the same data. */
export interface AdapterCapabilities {
  /** Can produce usage windows at all. */
  usage: boolean;
  /** Where usage comes from. 'local-files' never touches the network. */
  usageSources: Array<'local-files' | 'oauth-api'>;
  /** Can resolve the logged-in account identity from a profile home. */
  identity: boolean;
  /** Window ids this adapter may emit (e.g. 'five_hour', 'weekly'). */
  windows: string[];
  /** Human-readable caveats, e.g. "OAuth usage endpoint is undocumented". */
  notes?: string;
}

/** Identity detected from a profile home's credentials/config. */
export interface ProviderIdentity {
  /** Primary account identifier — email where available. */
  account: string | null;
  /** Organization / workspace name where available. */
  organization: string | null;
  /** Subscription plan label where available (e.g. "max", "pro"). */
  plan: string | null;
}
