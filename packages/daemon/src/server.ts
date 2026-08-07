import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { ApiError, OverviewResponse, StatusResponse } from '@apm/shared';
import { ensureDirs, removeRunFile, writeRunFile, type DaemonConfig } from './config.js';
import { ApiFailure, type AppContext } from './context.js';
import { createEventBus } from './core/events.js';
import { createProfileService } from './core/profiles.js';
import { createUsageService } from './core/usage.js';
import { registerCoreRoutes } from './core/routes.js';
import { createSessionHost } from './sessions/host.js';
import { attachTerminalWs } from './sessions/ws.js';
import { registerSessionRoutes } from './sessions/routes.js';
import { createT3Manager } from './t3/manager.js';
import { registerT3Routes } from './t3/routes.js';

export interface DaemonHandle {
  config: DaemonConfig;
  url: string;
  app: FastifyInstance;
  close(): Promise<void>;
}

function isLocalOrigin(origin: string): boolean {
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

/**
 * Origin gate for browser-initiated requests. Non-browser clients (no Origin
 * header) pass; browsers must come from a localhost origin. This blocks
 * cross-site requests from arbitrary websites even though we also require the
 * bearer token.
 */
export function originAllowed(origin: string | undefined): boolean {
  if (origin === undefined || origin === 'null') return origin === undefined;
  return isLocalOrigin(origin);
}

function findWebDist(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // packages/daemon/dist/server.js -> packages/web/dist
    path.resolve(here, '..', '..', 'web', 'dist'),
    // packages/daemon/src/server.ts (tsx dev) -> packages/web/dist
    path.resolve(here, '..', '..', 'web', 'dist'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  }
  return null;
}

export async function createContext(config: DaemonConfig): Promise<AppContext> {
  ensureDirs(config);
  const events = createEventBus();
  const profiles = createProfileService(config, events);
  const usage = createUsageService(config, events, profiles);
  const sessions = createSessionHost(config, events, profiles);
  const t3 = createT3Manager(config, events, profiles);
  return { config, events, profiles, usage, sessions, t3 };
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

  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof ApiFailure) {
      return reply.code(error.statusCode).send(err(error.code, error.message));
    }
    if ('validation' in error && error.validation) {
      return reply.code(400).send(err('bad-request', error.message));
    }
    // Never leak internals; message only.
    return reply.code(500).send(err('internal', error.message || 'Internal error'));
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
    usage: ctx.usage.latest(),
    sessions: ctx.sessions.list(),
    t3Instances: ctx.t3.list(),
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
  registerT3Routes(app, ctx);

  // ---- static web app -----------------------------------------------------
  const webDist = findWebDist();
  if (webDist) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api') || req.url.startsWith('/ws')) {
        return reply.code(404).send(err('not-found', 'No such endpoint'));
      }
      return reply.sendFile('index.html');
    });
  }

  await app.listen({ host: config.host, port: config.port });

  // Terminal WebSocket upgrades (token + origin enforced inside).
  attachTerminalWs(app.server, ctx);

  writeRunFile(config);
  await ctx.t3.adopt();
  ctx.usage.start();

  const url = `http://${config.host}:${config.port}/?token=${config.token}`;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    ctx.usage.stop();
    ctx.sessions.shutdown();
    ctx.t3.shutdown();
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
