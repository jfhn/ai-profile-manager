import type { Profile } from '@apm/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../stores.svelte';
import { FakeDaemon } from '../test-support/fake-daemon';
import NewT3Modal from './NewT3Modal.svelte';

const mocks = vi.hoisted(() => ({ daemon: null as unknown as FakeDaemon }));

vi.mock('../api', () => ({
  token: 'test-token',
  eventsUrl: () => 'http://localhost/api/events',
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  api: {
    targetProfiles: (id: string) => mocks.daemon.targetProfiles(id),
    createT3: (body: Parameters<FakeDaemon['createT3']>[0]) => mocks.daemon.createT3(body),
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
  mocks.daemon.seedTarget({ id: 'local', label: 'workstation' });
  mocks.daemon.seedTarget({ id: 'dev-box', label: 'dev box' });
  mocks.daemon.targetProfileLists = {
    'dev-box': [
      {
        id: 'claude-remote',
        provider: 'claude',
        label: 'dev box work',
        status: 'active',
        enabled: true,
      },
      { id: 'codex-stale', provider: 'codex', label: 'old', status: 'error', enabled: true },
    ],
  };
  app.targets = mocks.daemon.targets;
  app.providers = [];
  app.profiles = [localProfile()];
  app.t3Instances = [];
  // The target-profile cache is shared with the instance cards and outlives
  // any one component, so every test starts from an unread one.
  app.targetProfiles = {};
});

describe('NewT3Modal: choosing where an instance runs', () => {
  it('defaults to the local target and keeps the request target-free', async () => {
    render(NewT3Modal, { onclose: () => undefined });

    const target = screen.getByLabelText<HTMLSelectElement>('Target');
    expect(target.value).toBe('local');
    expect([...target.options].map((option) => option.textContent?.trim())).toEqual([
      'workstation · this machine',
      'dev box',
    ]);
    // The local flow is untouched: one select per provider.
    expect(screen.getByLabelText('Claude profile')).toBeDefined();

    await fireEvent.input(screen.getByLabelText('Label'), { target: { value: 'work' } });
    await fireEvent.change(screen.getByLabelText('Claude profile'), {
      target: { value: 'claude-local' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(mocks.daemon.createdT3).toHaveLength(1));
    expect(mocks.daemon.createdT3[0]).toEqual({
      label: 'work',
      profiles: { claude: 'claude-local' },
    });
    expect(app.t3Instances.map((instance) => instance.label)).toEqual(['work']);
  });

  it('offers the remote target’s own active profiles per provider', async () => {
    render(NewT3Modal, { onclose: () => undefined });

    await fireEvent.change(screen.getByLabelText('Target'), { target: { value: 'dev-box' } });

    const claude = await screen.findByLabelText<HTMLSelectElement>('Claude profile on dev box');
    // Only what that target reports, and only what is usable there.
    await waitFor(() =>
      expect([...claude.options].map((option) => option.value)).toEqual(['', 'claude-remote']),
    );
    // The target's only codex profile is unusable, so that provider stays open.
    const codex = screen.getByLabelText<HTMLSelectElement>('Codex profile on dev box');
    expect([...codex.options].map((option) => option.value)).toEqual(['']);
    expect(codex.hasAttribute('disabled')).toBe(true);
    expect(screen.queryByLabelText('Claude profile')).toBeNull();
    expect(screen.getByText(/credentials stay there/)).toBeDefined();

    await fireEvent.input(screen.getByLabelText('Label'), { target: { value: 'dev' } });
    await fireEvent.change(claude, { target: { value: 'claude-remote' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(mocks.daemon.createdT3).toHaveLength(1));
    expect(mocks.daemon.createdT3[0]).toEqual({
      label: 'dev',
      targetId: 'dev-box',
      profiles: { claude: 'claude-remote' },
    });
  });

  it('binds one remote profile per provider in a single request', async () => {
    mocks.daemon.targetProfileLists['dev-box'] = [
      ...(mocks.daemon.targetProfileLists['dev-box'] ?? []),
      {
        id: 'codex-remote',
        provider: 'codex',
        label: 'dev box codex',
        status: 'active',
        enabled: true,
      },
    ];
    render(NewT3Modal, { onclose: () => undefined });

    await fireEvent.change(screen.getByLabelText('Target'), { target: { value: 'dev-box' } });
    const claude = await screen.findByLabelText<HTMLSelectElement>('Claude profile on dev box');
    const codex = screen.getByLabelText<HTMLSelectElement>('Codex profile on dev box');
    await waitFor(() =>
      expect([...codex.options].map((option) => option.value)).toEqual(['', 'codex-remote']),
    );

    await fireEvent.input(screen.getByLabelText('Label'), { target: { value: 'both' } });
    await fireEvent.change(claude, { target: { value: 'claude-remote' } });
    await fireEvent.change(codex, { target: { value: 'codex-remote' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(mocks.daemon.createdT3).toHaveLength(1));
    expect(mocks.daemon.createdT3[0]).toEqual({
      label: 'both',
      targetId: 'dev-box',
      profiles: { claude: 'claude-remote', codex: 'codex-remote' },
    });
  });

  it('reports a target that cannot list its profiles', async () => {
    mocks.daemon.targetProfileLists = {};
    render(NewT3Modal, { onclose: () => undefined });

    await fireEvent.change(screen.getByLabelText('Target'), { target: { value: 'dev-box' } });

    expect(await screen.findByText('No target "dev-box"')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Create' }).hasAttribute('disabled')).toBe(true);
  });

  it('hides a target that cannot host an instance', () => {
    mocks.daemon.seedTarget({ id: 'exec-only', label: 'build box', capabilities: ['exec'] });
    mocks.daemon.seedTarget({ id: 'pending', label: 'not approved yet', approved: false });
    app.targets = mocks.daemon.targets;

    render(NewT3Modal, { onclose: () => undefined });

    const target = screen.getByLabelText<HTMLSelectElement>('Target');
    expect([...target.options].map((option) => option.value)).toEqual(['local', 'dev-box']);
  });
});
