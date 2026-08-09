import { render, screen } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../stores.svelte';
import { FakeDaemon } from '../test-support/fake-daemon';
import T3Card from './T3Card.svelte';

const mocks = vi.hoisted(() => ({ daemon: null as unknown as FakeDaemon }));

// The card pulls in the real api module through stores and toasts, which would
// resolve a daemon token and make network calls. Nothing here mutates, so only
// the module surface has to exist.
vi.mock('../api', () => ({
  token: 'test-token',
  eventsUrl: () => 'http://localhost/api/events',
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  api: {
    startT3: (id: string) => mocks.daemon.startT3(id),
    stopT3: (id: string) => mocks.daemon.stopT3(id),
    deleteT3: (id: string) => mocks.daemon.deleteT3(id),
  },
}));

beforeEach(() => {
  mocks.daemon = new FakeDaemon();
  app.targets = [];
  app.profiles = [];
});

describe('T3Card: which machine an instance runs on', () => {
  it('labels a local instance as local and links its loopback URL', () => {
    mocks.daemon.seedTarget({ id: 'local', label: 'workstation' });
    app.targets = mocks.daemon.targets;
    const instance = mocks.daemon.runT3Instance(mocks.daemon.seedT3Instance({ label: 'work' }), {
      scope: 'loopback',
      port: 4800,
      url: 'http://127.0.0.1:4800',
    });

    render(T3Card, { instance });

    expect(screen.getByText('workstation')).toBeDefined();
    expect(screen.getByText('local')).toBeDefined();
    expect(screen.getByText('loopback')).toBeDefined();
    expect(screen.getByText('http://127.0.0.1:4800')).toBeDefined();
    expect(screen.getByRole('link', { name: 'Open' }).getAttribute('href')).toBe(
      'http://127.0.0.1:4800',
    );
  });

  it('names the target and its published endpoint for a remote instance', () => {
    mocks.daemon.seedTarget({ id: 'local', label: 'workstation' });
    mocks.daemon.seedTarget({ id: 'dev-box', label: 'dev box' });
    app.targets = mocks.daemon.targets;
    const instance = mocks.daemon.runT3Instance(
      mocks.daemon.seedT3Instance({ label: 'dev', targetId: 'dev-box' }),
      { scope: 'published', port: 9100, url: 'http://dev-box.tailnet.ts.net:9100' },
    );

    render(T3Card, { instance });

    expect(screen.getByText('dev box')).toBeDefined();
    expect(screen.getByText('remote')).toBeDefined();
    expect(screen.getByText('published')).toBeDefined();
    // The whole point of the row: the host is on screen, so a tailnet URL can
    // never read as a localhost one.
    expect(screen.getByText('http://dev-box.tailnet.ts.net:9100')).toBeDefined();
    expect(screen.getByText(/reachable from your trusted network/)).toBeDefined();

    const open = screen.getByRole('link', { name: 'Open' });
    expect(open.getAttribute('href')).toBe('http://dev-box.tailnet.ts.net:9100');
    expect(open.getAttribute('href')).not.toContain('127.0.0.1');
  });

  it('warns that a forwarded endpoint only opens on the machine running apm', () => {
    mocks.daemon.seedTarget({ id: 'dev-box', label: 'dev box' });
    app.targets = mocks.daemon.targets;
    const instance = mocks.daemon.runT3Instance(
      mocks.daemon.seedT3Instance({ label: 'dev', targetId: 'dev-box' }),
      { scope: 'forwarded', port: 9100, url: 'http://127.0.0.1:9100' },
    );

    render(T3Card, { instance });

    expect(screen.getByText('forwarded')).toBeDefined();
    expect(screen.getByText(/only opens here/)).toBeDefined();
  });

  it('falls back to the target id when the registry has not been loaded', () => {
    const instance = mocks.daemon.seedT3Instance({ label: 'dev', targetId: 'dev-box' });
    render(T3Card, { instance });
    expect(screen.getByText('dev-box')).toBeDefined();
  });
});
