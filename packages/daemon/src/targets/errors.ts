/**
 * One table mapping transport failures onto the HTTP error codes the API
 * already speaks, so every consumer reports
 * the same thing for the same failure.
 */
import { isTransportError, type TransportErrorCode } from '@apm/shared';
import { ApiFailure } from '../context.js';

const API_ERRORS: Record<TransportErrorCode, { status: number; code: string }> = {
  'target-not-found': { status: 404, code: 'target-not-found' },
  'target-not-approved': { status: 403, code: 'target-not-approved' },
  unsupported: { status: 400, code: 'target-unsupported' },
  unreachable: { status: 502, code: 'target-unreachable' },
  unauthorized: { status: 502, code: 'target-unauthorized' },
  closed: { status: 409, code: 'target-closed' },
  'profile-not-found': { status: 404, code: 'profile-not-found' },
  // Kept identical to the pre-transport session errors.
  'cwd-not-found': { status: 400, code: 'bad-cwd' },
  'command-not-found': { status: 400, code: 'app-not-found' },
  'spawn-failed': { status: 400, code: 'spawn-failed' },
  timeout: { status: 504, code: 'target-timeout' },
};

/** ApiFailure for a transport error; anything else is rethrown untouched. */
export function toApiFailure(error: unknown): ApiFailure {
  if (!isTransportError(error)) throw error;
  const mapped = API_ERRORS[error.code];
  return new ApiFailure(mapped.status, mapped.code, error.message);
}
