// STUB — implemented by the daemon-core module.
import type { ServerEvent } from '@apm/shared';
import type { EventBus } from '../context.js';

export function createEventBus(): EventBus {
  const listeners = new Set<(event: ServerEvent) => void>();
  return {
    emit(event) {
      for (const listener of listeners) listener(event);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
