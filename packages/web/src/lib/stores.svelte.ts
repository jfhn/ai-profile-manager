import type {
  DiscoveryCandidate,
  Profile,
  ProviderId,
  ProviderInfo,
  ServerEvent,
  StatusResponse,
  T3Instance,
  TerminalSession,
  UsageSnapshot,
} from '@apm/shared';
import { api, errorMessage, eventsUrl, token } from './api';

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  claude: 'Claude',
  codex: 'Codex',
};

export type ConnectionState = 'connecting' | 'live' | 'offline';

class AppStore {
  /** First overview fetch is still in flight — the UI shows skeletons. */
  loading = $state(true);
  /** Fatal boot error (daemon unreachable / bad token). */
  bootError = $state<string | null>(null);

  status = $state<StatusResponse | null>(null);
  providers = $state<ProviderInfo[]>([]);
  profiles = $state<Profile[]>([]);
  usage = $state<Record<string, UsageSnapshot>>({});
  sessions = $state<TerminalSession[]>([]);
  t3Instances = $state<T3Instance[]>([]);
  discovery = $state<DiscoveryCandidate[]>([]);

  connection = $state<ConnectionState>('connecting');

  /** Profiles that can back a new session or T3 instance. */
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
}

export const app = new AppStore();

export async function loadOverview(): Promise<void> {
  const overview = await api.overview();
  app.providers = overview.providers;
  app.profiles = overview.profiles;
  app.usage = overview.usage;
  app.sessions = overview.sessions;
  app.t3Instances = overview.t3Instances;
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
    case 't3-changed':
      app.t3Instances = event.instances;
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
    if (hadConnection) void refreshAll();
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
  stream.addEventListener('t3-changed', handle('t3-changed'));
  stream.addEventListener('profiles-changed', handle('profiles-changed'));
}
