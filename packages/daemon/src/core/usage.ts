import fs from 'node:fs';
import path from 'node:path';
import { adapters as defaultAdapters } from '@apm/collectors';
import type { UsageSnapshot } from '@apm/shared';
import type { DaemonConfig } from '../config.js';
import {
  ApiFailure,
  type EventBus,
  type ProfileService,
  type RefreshOptions,
  type UsageService,
} from '../context.js';
import { UsageDatabase } from './db.js';
import { profileCacheDirectory } from './profilePaths.js';
import type { AdapterRegistry } from './profiles.js';

const REFRESH_INTERVAL_MS = 60_000;
const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const RETENTION_MS = 30 * RETENTION_INTERVAL_MS;

export function createUsageService(
  config: DaemonConfig,
  events: EventBus,
  profiles: ProfileService,
  adapterRegistry: AdapterRegistry = defaultAdapters,
): UsageService {
  const db = new UsageDatabase(config.usageDb);
  const latest = db.latest();
  let refreshTimer: NodeJS.Timeout | null = null;
  let retentionTimer: NodeJS.Timeout | null = null;

  function prune(): void {
    db.deleteBefore(new Date(Date.now() - RETENTION_MS).toISOString());
  }

  async function refresh(profileId?: string, options?: RefreshOptions): Promise<void> {
    const targets = profileId
      ? [profileOrThrow(profiles, profileId)]
      : profiles.list().filter((profile) => profile.enabled && profile.status !== 'pending');

    for (const profile of targets) {
      const cacheDir = profileCacheDirectory(config.cacheDir, profile.id);
      let snapshot: UsageSnapshot;
      try {
        if (!isChildPath(config.cacheDir, cacheDir)) {
          throw new Error('Invalid profile cache path');
        }
        fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
        fs.chmodSync(cacheDir, 0o700);
        const adapter = adapterRegistry[profile.provider];
        if (!adapter) throw new Error(`No adapter for provider ${profile.provider}`);
        const result = await adapter.collectUsage({
          home: profile.home,
          cacheDir,
          allowNetwork: true,
          // Replicas never rotate tokens — the sync owner is the sole
          // background refresher; a replica reports the auth failure and the
          // sync service pulls fresh credentials instead.
          allowRefresh: profile.sync?.role !== 'replica',
          force: options?.force === true,
        });
        snapshot = {
          ...result,
          profileId: profile.id,
          fetchedAt: new Date().toISOString(),
        };
      } catch (error) {
        snapshot = errorSnapshot(profile.id, new Date().toISOString(), error);
      }
      db.insert(snapshot);
      latest[profile.id] = snapshot;
      events.emit({
        type: 'usage-updated',
        profileId: profile.id,
        snapshot,
      });
    }
  }

  return {
    latest() {
      return { ...latest };
    },

    refresh,

    start() {
      if (refreshTimer) return;
      prune();
      void refresh().catch(() => undefined);
      refreshTimer = setInterval(() => void refresh().catch(() => undefined), REFRESH_INTERVAL_MS);
      refreshTimer.unref();
      retentionTimer = setInterval(prune, RETENTION_INTERVAL_MS);
      retentionTimer.unref();
    },

    stop() {
      if (refreshTimer) clearInterval(refreshTimer);
      if (retentionTimer) clearInterval(retentionTimer);
      refreshTimer = null;
      retentionTimer = null;
    },
  };
}

function profileOrThrow(profiles: ProfileService, id: string) {
  const profile = profiles.get(id);
  if (!profile) throw new ApiFailure(404, 'not-found', 'Profile not found');
  return profile;
}

function isChildPath(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), candidate);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function errorSnapshot(profileId: string, fetchedAt: string, error: unknown): UsageSnapshot {
  return {
    profileId,
    fetchedAt,
    windows: [],
    source: 'adapter',
    cacheStatus: 'error',
    dataUpdatedAt: null,
    stale: true,
    staleReason: 'Usage collection failed',
    failureKind: 'error',
    error: redactError(error),
    planType: null,
    retryAfterSeconds: null,
  };
}

function redactError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, '$1[redacted]')
    .replace(
      /((?:access[_-]?token|refresh[_-]?token|api[_-]?key|password)\s*[=:]\s*)[^\s,;]+/gi,
      '$1[redacted]',
    )
    .replace(/\b(?:sk|key|token)-[A-Za-z0-9_-]{12,}\b/g, '[redacted]')
    .slice(0, 500);
}
