import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { ApiError, OverviewResponse, StatusResponse } from '@apm/shared';
import { ensureDirs, removeRunFile, writeRunFile, type DaemonConfig } from './config.js';
import { ApiFailure, type AppContext } from './context.js';
import { originAllowed } from './security.js';
import { createEventBus } from './core/events.js';
import { createProfileService } from './core/profiles.js';
import { createUsageService } from './core/usage.js';
import { registerCoreRoutes } from './core/routes.js';
import { createSessionHost } from './sessions/host.js';
import { attachTerminalWs } from './sessions/ws.js';
import { registerSessionRoutes } from './sessions/routes.js';
import { createLocalTransport } from './targets/local.js';
import { createTargetRegistry } from './targets/registry.js';
import { createConfiguredTransports } from './targets/config.js';
import { registerTargetRoutes } from './targets/routes.js';
import { createSyncService } from './targets/sync.js';

export interface DaemonHandle {
  config: DaemonConfig;
  url: string;
  app: FastifyInstance;
  close(): Promise<void>;
}

function findWebDist(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Both packages/daemon/dist/server.js and packages/daemon/src/server.ts sit
  // one directory below the package root, so the same path works in both modes.
  const dir = path.resolve(here, '..', '..', 'web', 'dist');
  return fs.existsSync(path.join(dir, 'index.html')) ? dir : null;
}

export async function createContext(config: DaemonConfig): Promise<AppContext> {
  ensureDirs(config);
  const events = createEventBus();
  const profiles = createProfileService(config, events);
  const usage = createUsageService(config, events, profiles);
  // One local transport for the whole daemon; configured remotes are resolved
  // only through the same approved registry.
  const localTransport = createLocalTransport({ profiles, shimsDir: config.shimsDir });
  const targets = createTargetRegistry(localTransport, createConfiguredTransports(config));
  const sessions = createSessionHost(config, events, profiles, { targets });
  const sync = createSyncService(config, profiles, targets, usage, events);
  return { config, events, profiles, usage, sessions, targets, sync };
}

export async function startDaemon(config: DaemonConfig): Promise<DaemonHandle> {
  const ctx = await createContext(config);

  const app = Fastify({ logger: false });

  // ---- security gates -----------------------------------------------------
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api')) return; // static assets are public; WS handled separately

    if (!originAllowed(req.headers.origin)) {
      return reply.code(403).send(err('forbidden-origin', 'Cross-origin requests are not allowed'));
    }

    const auth = req.headers.authorization;
    const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
    const queryToken = (req.query as Record<string, unknown> | null)?.token;
    const token = bearer ?? (typeof queryToken === 'string' ? queryToken : null);
    if (token !== config.token) {
      return reply.code(401).send(err('unauthorized', 'Missing or invalid auth token'));
    }
  });

  app.setErrorHandler((error: unknown, _req, reply) => {
    if (error instanceof ApiFailure) {
      return reply.code(error.statusCode).send(err(error.code, error.message));
    }
    const anyError = error as { validation?: unknown; message?: string };
    if (anyError.validation) {
      return reply.code(400).send(err('bad-request', anyError.message ?? 'Invalid request'));
    }
    // Never leak internals; message only.
    return reply.code(500).send(err('internal', anyError.message || 'Internal error'));
  });

  // ---- built-in routes ----------------------------------------------------
  const startedAt = new Date().toISOString();
  app.get('/api/status', async (): Promise<StatusResponse> => ({
    name: 'apm',
    version: config.version,
    pid: process.pid,
    startedAt,
    dataDir: config.dataDir,
  }));

  app.get('/api/overview', async (): Promise<OverviewResponse> => ({
    providers: ctx.profiles.providers(),
    profiles: ctx.profiles.list(),
    defaultProfileIds: ctx.profiles.defaults(),
    usage: ctx.usage.latest(),
    sessions: ctx.sessions.list(),
  }));

  app.get('/api/events', (req, reply) => {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    reply.raw.write(':ok\n\n');
    const unsubscribe = ctx.events.subscribe((event) => {
      reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    });
    const keepAlive = setInterval(() => reply.raw.write(':ping\n\n'), 25_000);
    req.raw.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  });

  // ---- module routes ------------------------------------------------------
  registerCoreRoutes(app, ctx);
  registerSessionRoutes(app, ctx);
  registerTargetRoutes(app, ctx);

  // ---- static web app -----------------------------------------------------
  const webDist = findWebDist();
  if (webDist) {
    // wildcard:true resolves files from disk per request — a rebuilt web
    // bundle (new asset hashes) must not require a daemon restart.
    await app.register(fastifyStatic, { root: webDist, wildcard: true });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api') || req.url.startsWith('/ws')) {
        return reply.code(404).send(err('not-found', 'No such endpoint'));
      }
      return reply.sendFile('index.html');
    });
  }

  await app.listen({ host: config.host, port: config.port });

  // Terminal WebSocket upgrades (token + origin enforced inside).
  const terminalWs = attachTerminalWs(app.server, ctx);

  writeRunFile(config);
  ctx.usage.start();
  ctx.sync.start();
  // The sweep runs after the daemon is already listening, so a failing persist
  // or event listener must not become an uncaught exception.
  setImmediate(() => {
    try {
      ctx.profiles.refreshIdentities();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`apm: identity refresh failed: ${message}`);
    }
  });

  const url = `http://${config.host}:${config.port}/?token=${config.token}`;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    ctx.sync.stop();
    ctx.usage.stop();
    // Upgraded sockets are not owned by Fastify. Close them explicitly or
    // app.close() waits forever while a terminal client remains attached.
    await terminalWs.close();
    await ctx.sessions.shutdown();
    await ctx.targets.close();
    removeRunFile(config);
    await app.close();
  };
  process.once('SIGINT', () => void close().then(() => process.exit(0)));
  process.once('SIGTERM', () => void close().then(() => process.exit(0)));

  return { config, url, app, close };
}

function err(code: string, message: string): ApiError {
  return { error: { code, message } };
}
