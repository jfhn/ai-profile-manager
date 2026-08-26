/** Hand-rolled hash routing for the four top-level pages. */

export const ROUTES = ['/', '/sessions', '/tools', '/targets'] as const;
export type RoutePath = (typeof ROUTES)[number];

function readHash(): RoutePath {
  const raw = window.location.hash.replace(/^#/, '');
  const path = raw.startsWith('/') ? raw : '/';
  return (ROUTES as readonly string[]).includes(path) ? (path as RoutePath) : '/';
}

class Router {
  path = $state<RoutePath>('/');

  constructor() {
    this.path = readHash();
    window.addEventListener('hashchange', () => {
      this.path = readHash();
    });
  }
}

export const router = new Router();

export function navigate(path: RoutePath): void {
  window.location.hash = `#${path}`;
}
