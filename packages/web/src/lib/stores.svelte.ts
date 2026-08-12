import type {
  DefaultProfileIds,
  DiscoveryCandidate,
  ExecutionTarget,
  Profile,
  ProviderId,
  ProviderInfo,
  ServerEvent,
  StatusResponse,
  TerminalSession,
  UsageSnapshot,
} from '@apm/shared';
import { api, errorMessage, eventsUrl, token } from './api';

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  claude: 'Claude',
  codex: 'Codex',
};

/**
 * Mirror of shared's LOCAL_TARGET_ID. The web app imports types only from
 * @apm/shared so the bundle stays free of zod, hence the copy.
 */
export const LOCAL_TARGET_ID = 'local';

export type ConnectionState = 'connecting' | 'live' | 'offline';

class AppStore {
  /** First overview fetch is still in flight — the UI shows skeletons. */
  loading = $state(true);
  /** Fatal boot error (daemon unreachable / bad token). */
  bootError = $state<string | null>(null);

  status = $state<StatusResponse | null>(null);
  providers = $state<ProviderInfo[]>([]);
  profiles = $state<Profile[]>([]);
  defaultProfileIds = $state<DefaultProfileIds>({});
  usage = $state<Record<string, UsageSnapshot>>({});
  sessions = $state<TerminalSession[]>([]);
  discovery = $state<DiscoveryCandidate[]>([]);
  /** Execution targets the daemon knows; the local one is always among them. */
  targets = $state<ExecutionTarget[]>([]);
  connection = $state<ConnectionState>('connecting');

  /** Profiles that can back a new session. */
  launchable = $derived(
    this.profiles.filter((profile) => profile.enabled && profile.status === 'active'),
  );

  profile(id: string | null | undefined): Profile | undefined {
    if (!id) return undefined;
    return this.profiles.find((candidate) => candidate.id === id);
  }

  profileLabel(id: string | null | undefined): string {
    return this.profile(id)?.label ?? 'unknown profile';
  }

  providerLabel(provider: ProviderId): string {
    return this.providers.find((info) => info.id === provider)?.label ?? PROVIDER_LABELS[provider];
  }

  target(id: string | null | undefined): ExecutionTarget | undefined {
    if (!id) return undefined;
    return this.targets.find((candidate) => candidate.id === id);
  }

  /** The target's own name, falling back to its id so a link is never nameless. */
  targetLabel(id: string | null | undefined): string {
    const target = this.target(id);
    if (target) return target.label;
    return id === LOCAL_TARGET_ID || !id ? 'this machine' : id;
  }
}

export const app = new AppStore();

export async function loadOverview(): Promise<void> {
  const overview = await api.overview();
  app.providers = overview.providers;
  app.profiles = overview.profiles;
  app.defaultProfileIds = overview.defaultProfileIds;
  app.usage = overview.usage;
  app.sessions = overview.sessions;
}

export async function loadTargets(): Promise<void> {
  try {
    app.targets = await api.targets();
  } catch {
    // An older daemon has no /api/targets; everything then runs locally, which
    // is what an empty list means to the pickers.
    app.targets = [];
  }
}

export async function loadDiscovery(): Promise<void> {
  try {
    const { candidates } = await api.discovery();
    app.discovery = candidates;
  } catch {
    // Discovery is a convenience; a failure must not break the dashboard.
    app.discovery = [];
  }
}

/** Refetch overview + discovery, swallowing errors (used after mutations). */
export async function refreshAll(): Promise<void> {
  try {
    await loadOverview();
    await loadDiscovery();
  } catch (error) {
    app.bootError ??= errorMessage(error);
  }
}

export async function boot(): Promise<void> {
  try {
    const [status] = await Promise.all([api.status(), loadOverview()]);
    app.status = status;
    app.bootError = null;
  } catch (error) {
    app.bootError = errorMessage(error);
    return;
  } finally {
    app.loading = false;
  }
  void loadDiscovery();
  void loadTargets();
  connectEvents();
}

// ---- SSE ------------------------------------------------------------------

let source: EventSource | null = null;
let backoff = 1000;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let hadConnection = false;

function apply(event: ServerEvent): void {
  switch (event.type) {
    case 'usage-updated':
      app.usage = { ...app.usage, [event.profileId]: event.snapshot };
      break;
    case 'sessions-changed':
      app.sessions = event.sessions;
      break;
    case 'profiles-changed':
      void refreshAll();
      break;
  }
}

function handle(type: ServerEvent['type']) {
  return (message: MessageEvent<string>) => {
    try {
      const parsed = JSON.parse(message.data) as Partial<ServerEvent>;
      apply({ ...parsed, type } as ServerEvent);
    } catch {
      // Ignore malformed frames rather than tearing down the stream.
    }
  };
}

export function connectEvents(): void {
  if (!token) return;
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  source?.close();

  const stream = new EventSource(eventsUrl());
  source = stream;
  app.connection = hadConnection ? 'offline' : 'connecting';

  stream.onopen = () => {
    app.connection = 'live';
    backoff = 1000;
    // Always resync: any event emitted between the initial overview fetch and
    // this stream opening (e.g. our own terminal attaching) was lost.
    void refreshAll();
    hadConnection = true;
  };

  stream.onerror = () => {
    app.connection = 'offline';
    stream.close();
    if (source === stream) source = null;
    reconnectTimer = setTimeout(connectEvents, backoff);
    backoff = Math.min(backoff * 2, 15_000);
  };

  stream.addEventListener('usage-updated', handle('usage-updated'));
  stream.addEventListener('sessions-changed', handle('sessions-changed'));
  stream.addEventListener('profiles-changed', handle('profiles-changed'));
}
