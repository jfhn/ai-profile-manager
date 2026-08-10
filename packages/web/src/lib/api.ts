import type {
  ApiError,
  ConfirmWizardRequest,
  CreateProfileRequest,
  CreateSessionRequest,
  CreateT3InstanceRequest,
  DefaultsResponse,
  DiscoveryResponse,
  OverviewResponse,
  Profile,
  ProviderId,
  RecentDirsResponse,
  StartWizardRequest,
  StatusResponse,
  T3Instance,
  TerminalSession,
  UpdateProfileRequest,
  UpdateDefaultProfileRequest,
  UsageSnapshot,
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

export class ApiRequestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ApiRequestError';
    this.code = code;
    this.status = status;
  }
}

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
    throw new ApiRequestError('network', 'Cannot reach the apm daemon', 0);
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
      throw new ApiRequestError(payload.error.code, payload.error.message, response.status);
    }
    throw new ApiRequestError('http-error', `Request failed (${response.status})`, response.status);
  }

  return payload as T;
}

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });

/**
 * The daemon answers list endpoints with an envelope ({ sessions }, { instances })
 * while the shared types describe bare arrays. Accept either so the client keeps
 * working whichever way the contract settles.
 */
function unwrapList<T>(payload: unknown, key: string): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === 'object') {
    const inner = (payload as Record<string, unknown>)[key];
    if (Array.isArray(inner)) return inner as T[];
  }
  return [];
}

export const api = {
  status: () => request<StatusResponse>('/api/status'),
  overview: () => request<OverviewResponse>('/api/overview'),
  discovery: () => request<DiscoveryResponse>('/api/discovery'),
  defaults: () => request<DefaultsResponse>('/api/defaults'),
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
  /** Answers 204 today; tolerates a snapshot body so the card can settle early. */
  refreshProfile: (id: string) =>
    request<UsageSnapshot | undefined>(`/api/profiles/${encodeURIComponent(id)}/refresh`, {
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

  sessions: async () =>
    unwrapList<TerminalSession>(await request<unknown>('/api/sessions'), 'sessions'),
  createSession: (body: CreateSessionRequest) =>
    request<TerminalSession>('/api/sessions', { method: 'POST', ...json(body) }),
  resizeSession: (id: string, cols: number, rows: number) =>
    request<void>(`/api/sessions/${encodeURIComponent(id)}/resize`, {
      method: 'POST',
      ...json({ cols, rows }),
    }),
  deleteSession: (id: string) =>
    request<void>(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  recentDirs: () => request<RecentDirsResponse>('/api/recent-dirs'),

  t3List: async () => unwrapList<T3Instance>(await request<unknown>('/api/t3'), 'instances'),
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
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong';
}
