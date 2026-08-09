/**
 * TCP/HTTP probes shared by the local transport and the T3 manager. Nothing
 * apm-specific lives here — just "is this port free" and "does it answer".
 */
import http from 'node:http';
import net from 'node:net';

export function portIsFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

/** Let the OS pick an unused port (bind :0, read it back, release it again). */
export function allocatePort(host = '127.0.0.1'): Promise<number | null> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(null));
    server.listen({ port: 0, host, exclusive: true }, () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : null;
      server.close(() => resolve(port));
    });
  });
}

export interface HttpProbeOptions {
  port: number;
  host?: string;
  path?: string;
  timeoutMs?: number;
}

/** True as soon as the port answers with any HTTP response. */
export function httpProbe(options: HttpProbeOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: options.host ?? '127.0.0.1',
        port: options.port,
        path: options.path ?? '/',
        method: 'GET',
        timeout: options.timeoutMs ?? 2_000,
      },
      (res) => {
        res.resume();
        resolve(true); // any HTTP status means the server is up
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}
