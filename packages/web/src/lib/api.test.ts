import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  sessionStorage.clear();
  sessionStorage.setItem('apm-token', 'test-token');
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('web API response contract', () => {
  it('returns the lists carried by the daemon response envelopes', async () => {
    const payloads: Record<string, unknown> = {
      '/api/sessions': { sessions: [{ id: 'session-1' }] },
      '/api/targets': { targets: [{ id: 'local' }] },
      '/api/targets/candidates': { candidates: [{ hostname: 'dev-box' }] },
      '/api/targets/dev-box/profiles': { profiles: [{ id: 'profile-1' }] },
      '/api/tools': { tools: [{ provider: 'codex', state: 'missing' }] },
    };
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) =>
      jsonResponse(payloads[String(input)]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { api } = await import('./api');

    expect(await api.sessions()).toEqual([{ id: 'session-1' }]);
    expect(await api.targets()).toEqual([{ id: 'local' }]);
    expect(await api.targetCandidates()).toEqual([{ hostname: 'dev-box' }]);
    expect(await api.targetProfiles('dev-box')).toEqual([{ id: 'profile-1' }]);
    expect(await api.tools()).toEqual([{ provider: 'codex', state: 'missing' }]);

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get('authorization')).toBe('Bearer test-token');
  });

  it('updates one provider through a fixed authenticated endpoint', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        previousVersion: 'codex-cli 1.0.0',
        tool: { provider: 'codex', state: 'installed', version: 'codex-cli 2.0.0' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { api } = await import('./api');

    await api.updateTool('codex');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/tools/codex/update',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('copies a profile only to the explicitly selected targets', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ profile: { id: 'profile-1' }, results: [] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { api } = await import('./api');

    await api.copyProfile('profile /1', { targetIds: ['dev-box', 'laptop'] });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/profiles/profile%20%2F1/copy',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ targetIds: ['dev-box', 'laptop'] }),
      }),
    );
  });

  it('treats the profile refresh 204 as a completed command with no response body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    const { api } = await import('./api');

    await expect(api.refreshProfile('profile-1')).resolves.toBeUndefined();
  });

  it('surfaces the daemon error message to callers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ error: { code: 'profile-not-found', message: 'Profile not found' } }, 404),
      ),
    );
    const { api } = await import('./api');

    await expect(api.refreshProfile('missing')).rejects.toThrow('Profile not found');
  });
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
