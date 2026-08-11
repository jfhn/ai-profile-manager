import type {
  AddTargetRequest,
  ApiError,
  ConfirmWizardRequest,
  CreateProfileRequest,
  CreateSessionRequest,
  CreateT3InstanceRequest,
  DefaultsResponse,
  DiscoveryResponse,
  ExecutionTarget,
  OverviewResponse,
  Profile,
  ProviderId,
  RecentDirsResponse,
  SessionsResponse,
  StartWizardRequest,
  StatusResponse,
  T3Instance,
  TargetCandidatesResponse,
  TargetProfilesResponse,
  TargetsResponse,
  TerminalSession,
  UpdateProfileRequest,
  UpdateDefaultProfileRequest,
  WizardStateResponse,
} from '@apm/shared';

const TOKEN_KEY = 'apm-token';

/**
 * The daemon prints a URL with ?token=<per-start token>. Capture it into
 * sessionStorage and scrub it from the address bar so it never ends up in
 * history, bookmarks or a screenshot.
 */
function resolveToken(): string | null {
  let stored: string | null = null;
  try {
    stored = sessionStorage.getItem(TOKEN_KEY);
  } catch {
    stored = null;
  }

  const url = new URL(window.location.href);
  const fromQuery = url.searchParams.get('token');
  if (fromQuery) {
    try {
      sessionStorage.setItem(TOKEN_KEY, fromQuery);
    } catch {
      /* private mode: keep the in-memory copy */
    }
    url.searchParams.delete('token');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    return fromQuery;
  }
  return stored;
}

export const token: string | null = resolveToken();

function isApiError(value: unknown): value is ApiError {
  if (typeof value !== 'object' || value === null) return false;
  const envelope = (value as { error?: unknown }).error;
  return (
    typeof envelope === 'object' &&
    envelope !== null &&
    typeof (envelope as { message?: unknown }).message === 'string'
  );
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch {
    throw new Error('Cannot reach the apm daemon');
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    if (isApiError(payload)) {
      throw new Error(payload.error.message);
    }
    throw new Error(`Request failed (${response.status})`);
  }

  return payload as T;
}

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });

export const api = {
  status: () => request<StatusResponse>('/api/status'),
  overview: () => request<OverviewResponse>('/api/overview'),
  discovery: () => request<DiscoveryResponse>('/api/discovery'),
  setDefault: (provider: ProviderId, body: UpdateDefaultProfileRequest) =>
    request<DefaultsResponse>(`/api/defaults/${encodeURIComponent(provider)}`, {
      method: 'PUT',
      ...json(body),
    }),

  createProfile: (body: CreateProfileRequest) =>
    request<Profile>('/api/profiles', { method: 'POST', ...json(body) }),
  updateProfile: (id: string, body: UpdateProfileRequest) =>
    request<Profile>(`/api/profiles/${encodeURIComponent(id)}`, { method: 'PATCH', ...json(body) }),
  deleteProfile: (id: string, purge = false) =>
    request<void>(`/api/profiles/${encodeURIComponent(id)}${purge ? '?purge=true' : ''}`, {
      method: 'DELETE',
    }),
  refreshProfile: (id: string) =>
    request<void>(`/api/profiles/${encodeURIComponent(id)}/refresh`, {
      method: 'POST',
    }),
  refreshAll: () => request<void>('/api/usage/refresh', { method: 'POST' }),

  startWizard: (body: StartWizardRequest) =>
    request<WizardStateResponse>('/api/wizard', { method: 'POST', ...json(body) }),
  wizardState: (profileId: string) =>
    request<WizardStateResponse>(`/api/wizard/${encodeURIComponent(profileId)}`),
  confirmWizard: (profileId: string, body: ConfirmWizardRequest) =>
    request<Profile>(`/api/wizard/${encodeURIComponent(profileId)}/confirm`, {
      method: 'POST',
      ...json(body),
    }),

  sessions: async () => (await request<SessionsResponse>('/api/sessions')).sessions,
  createSession: (body: CreateSessionRequest) =>
    request<TerminalSession>('/api/sessions', { method: 'POST', ...json(body) }),
  deleteSession: (id: string) =>
    request<void>(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  recentDirs: () => request<RecentDirsResponse>('/api/recent-dirs'),

  targets: async () => (await request<TargetsResponse>('/api/targets')).targets,
  /** Machines on this hub's tailnet. Listing them approves nothing. */
  targetCandidates: async () =>
    (await request<TargetCandidatesResponse>('/api/targets/candidates')).candidates,
  /** The approval act: one named machine becomes an execution target. */
  addTarget: (body: AddTargetRequest) =>
    request<ExecutionTarget>('/api/targets', { method: 'POST', ...json(body) }),
  /** Revoke a target: it leaves targets.json and its connection is closed. */
  deleteTarget: (id: string) =>
    request<void>(`/api/targets/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** Profile ids are target-scoped, so a picker must ask the target itself. */
  targetProfiles: async (id: string) =>
    (await request<TargetProfilesResponse>(`/api/targets/${encodeURIComponent(id)}/profiles`))
      .profiles,

  createT3: (body: CreateT3InstanceRequest) =>
    request<T3Instance>('/api/t3', { method: 'POST', ...json(body) }),
  startT3: (id: string) =>
    request<T3Instance>(`/api/t3/${encodeURIComponent(id)}/start`, { method: 'POST' }),
  stopT3: (id: string) =>
    request<T3Instance>(`/api/t3/${encodeURIComponent(id)}/stop`, { method: 'POST' }),
  deleteT3: (id: string) =>
    request<void>(`/api/t3/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};

export function eventsUrl(): string {
  return `/api/events?token=${encodeURIComponent(token ?? '')}`;
}

export function terminalSocketUrl(sessionId: string): string {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${window.location.host}/ws/terminal/${encodeURIComponent(sessionId)}?token=${encodeURIComponent(token ?? '')}`;
}

/** Human-readable message for anything thrown by the api layer. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'Something went wrong';
}
