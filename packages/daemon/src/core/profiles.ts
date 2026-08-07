// STUB — implemented by the daemon-core module.
import type { DaemonConfig } from '../config.js';
import type { EventBus, ProfileService } from '../context.js';

export function createProfileService(_config: DaemonConfig, _events: EventBus): ProfileService {
  throw new Error('not implemented');
}
