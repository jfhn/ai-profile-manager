// STUB — implemented by the sessions module.
import type { Server } from 'node:http';
import type { AppContext } from '../context.js';

export function attachTerminalWs(_server: Server, _ctx: AppContext): void {
  // ws upgrade handling for /ws/terminal/:sessionId
}
