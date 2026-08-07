/**
 * Origin gate for browser-initiated requests. Non-browser clients (no Origin
 * header) pass; browsers must come from a localhost origin. This blocks
 * cross-site requests from arbitrary websites even though we also require the
 * bearer token — terminal WebSockets are an arbitrary-code-execution surface.
 */
export function originAllowed(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  if (origin === 'null') return false;
  try {
    const url = new URL(origin);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1')
    );
  } catch {
    return false;
  }
}
