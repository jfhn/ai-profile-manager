import path from 'node:path';

const REQUEST_TIMEOUT_MS = 8_000;

export type FetchOutcome =
  | { kind: 'ok'; status: number; body: unknown }
  | { kind: 'http-error'; status: number }
  | { kind: 'timeout' }
  | { kind: 'failed'; error: unknown };

/**
 * One provider request under a hard deadline.
 *
 * The body is read only for a successful response: error bodies may echo token
 * material, and an unparsable one would hide the status callers classify on.
 */
export async function fetchJson(
  fetchImpl: typeof fetch | undefined,
  url: string,
  init: RequestInit,
): Promise<FetchOutcome> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await (fetchImpl ?? fetch)(url, { ...init, signal: controller.signal });
    if (!response.ok) return { kind: 'http-error', status: response.status };
    return { kind: 'ok', status: response.status, body: await response.json() };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return { kind: 'timeout' };
    return { kind: 'failed', error };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Run at most one refresh per resolved home: concurrent collections for the
 * same profile must never race a single-use refresh token. Late callers join
 * the pending refresh and get its outcome.
 */
export function refreshOnce<T>(
  inFlight: Map<string, Promise<T>>,
  home: string,
  run: () => Promise<T>,
): Promise<T> {
  const key = path.resolve(home);
  const pending = inFlight.get(key);
  if (pending) return pending;
  const started = run().finally(() => inFlight.delete(key));
  inFlight.set(key, started);
  return started;
}
