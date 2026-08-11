import type { Profile } from '@apm/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { app, loadTargetProfiles } from '../stores.svelte';
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
    targetProfiles: (id: string) => mocks.daemon.targetProfiles(id),
  },
}));

function localProfile(): Profile {
  return {
    id: 'claude-local',
    provider: 'claude',
    label: 'work',
    home: '/home/tester/.claude',
    homeKind: 'external',
    identity: null,
    status: 'active',
    statusReason: null,
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

beforeEach(() => {
  mocks.daemon = new FakeDaemon();
  app.targets = [];
  app.profiles = [];
  app.providers = [];
  app.t3Instances = [];
  // Shared with the create modal and outliving any one component, so each test
  // starts from an unread cache.
  app.targetProfiles = {};
});

describe('T3Card: applying command responses', () => {
  it('replaces the card state with the valid instance returned by stop', async () => {
    const instance = mocks.daemon.runT3Instance(mocks.daemon.seedT3Instance({ label: 'work' }), {
      scope: 'loopback',
      port: 4800,
      url: 'http://127.0.0.1:4800',
    });
    app.t3Instances = [instance];

    render(T3Card, { instance });
    await fireEvent.click(screen.getByRole('button', { name: 'Stop' }));

    await waitFor(() => expect(app.t3Instances[0]?.status).toBe('stopped'));
    expect(app.t3Instances[0]?.url).toBeNull();
  });
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

describe('T3Card: which machine owns the bound profile', () => {
  beforeEach(() => {
    mocks.daemon.seedTarget({ id: 'local', label: 'workstation' });
    mocks.daemon.seedTarget({ id: 'dev-box', label: 'dev box' });
    app.targets = mocks.daemon.targets;
    mocks.daemon.targetProfileLists = {
      'dev-box': [
        {
          id: 'd4f5751f-remote',
          provider: 'claude',
          label: 'hidden-logic',
          status: 'active',
          enabled: true,
        },
      ],
    };
  });

  it('reads a local instance’s profile from this machine', () => {
    app.profiles = [localProfile()];
    const instance = mocks.daemon.seedT3Instance({
      label: 'work',
      profiles: { claude: 'claude-local' },
    });

    render(T3Card, { instance });
    expect(screen.getByText(/Claude · work/)).toBeDefined();
  });

  it('reads a remote instance’s profile from its own target', async () => {
    // The id only exists over there — resolving it against this machine's
    // profiles is exactly the bug this covers.
    app.profiles = [localProfile()];
    const instance = mocks.daemon.seedT3Instance({
      label: 'dev',
      targetId: 'dev-box',
      profiles: { claude: 'd4f5751f-remote' },
    });
    await loadTargetProfiles('dev-box');

    render(T3Card, { instance });
    expect(screen.getByText(/Claude · hidden-logic/)).toBeDefined();
    expect(screen.queryByText(/missing profile/)).toBeNull();
  });

  it('still warns when the target really does not have the profile', async () => {
    const instance = mocks.daemon.seedT3Instance({
      label: 'dev',
      targetId: 'dev-box',
      profiles: { claude: 'deleted-over-there' },
    });
    await loadTargetProfiles('dev-box');

    render(T3Card, { instance });
    expect(screen.getByText(/Claude · missing profile/)).toBeDefined();
  });

  it('stays neutral while the target cannot be asked', async () => {
    mocks.daemon.targetProfileLists = {}; // the target is unreachable
    const instance = mocks.daemon.seedT3Instance({
      label: 'dev',
      targetId: 'dev-box',
      profiles: { claude: 'd4f5751f-remote' },
    });
    await loadTargetProfiles('dev-box');
    expect(app.targetProfiles['dev-box']?.state).toBe('error');

    render(T3Card, { instance });
    // Not knowing is not the same as the binding being broken.
    expect(screen.getByText(/Claude · profile on dev box/)).toBeDefined();
    expect(screen.queryByText(/missing profile/)).toBeNull();
  });

  it('resolves the label as soon as the target answers', async () => {
    const instance = mocks.daemon.seedT3Instance({
      label: 'dev',
      targetId: 'dev-box',
      profiles: { claude: 'd4f5751f-remote' },
    });

    render(T3Card, { instance });
    expect(screen.getByText(/Claude · profile on dev box/)).toBeDefined();

    await loadTargetProfiles('dev-box');
    await waitFor(() => expect(screen.getByText(/Claude · hidden-logic/)).toBeDefined());
  });

  it('asks each target once however many cards it has', async () => {
    const asked: string[] = [];
    const real = mocks.daemon.targetProfiles.bind(mocks.daemon);
    mocks.daemon.targetProfiles = async (id: string) => {
      asked.push(id);
      return real(id);
    };

    await Promise.all([
      loadTargetProfiles('dev-box'),
      loadTargetProfiles('dev-box'),
      loadTargetProfiles('dev-box'),
    ]);
    await loadTargetProfiles('dev-box');

    expect(asked).toEqual(['dev-box']);
  });
});
