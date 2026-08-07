// STUB — implemented by the sessions module.
import type { DaemonConfig } from '../config.js';
import type { EventBus, ProfileService, SessionHost } from '../context.js';

export function createSessionHost(
  _config: DaemonConfig,
  _events: EventBus,
  _profiles: ProfileService,
): SessionHost {
  throw new Error('not implemented');
}
