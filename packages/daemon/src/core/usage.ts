// STUB — implemented by the daemon-core module.
import type { DaemonConfig } from '../config.js';
import type { EventBus, ProfileService, UsageService } from '../context.js';

export function createUsageService(
  _config: DaemonConfig,
  _events: EventBus,
  _profiles: ProfileService,
): UsageService {
  throw new Error('not implemented');
}
