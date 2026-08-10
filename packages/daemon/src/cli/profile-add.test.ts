import { describe, expect, it } from 'vitest';
import type { Profile, ProviderId, ProviderIdentity } from '@apm/shared';
import { CliError } from './parse.js';
import { ApiRequestError, runProfileAdd, type ProfileAddDeps } from './profile-add.js';

/**
 * In-memory stand-in for the daemon's wizard endpoints, faithful to the real
 * service's rules: identity only appears once credentials exist, confirm
 * refuses missing credentials and duplicate labels, pending profiles survive
 * failures. The daemon bearer token is deliberately part of the fixture so
 * tests can assert it never reaches the CLI's output or the login process.
 */
class FakeDaemon {
  readonly token = 'daemon-secret-token';
  readonly profiles = new Map<string, Profile>();
  readonly takenLabels = new Set<string>();
  /** Homes whose (fake) provider login has completed. */
  readonly credentialed = new Set<string>();
  identity: ProviderIdentity | null = {
    account: 'alice@example.test',
    organization: null,
    plan: 'pro',
  };
  private nextId = 1;

  addPending(provider: ProviderId, createdAt: string): Profile {
    const id = `pending-${this.nextId++}`;
    const profile: Profile = {
      id,
      provider,
      label: `new-${provider}`,
      home: `/data/homes/${id}`,
      homeKind: 'managed',
      identity: null,
      status: 'pending',
      statusReason: null,
      enabled: true,
      createdAt,
    };
    this.profiles.set(id, profile);
    return profile;
  }

  api = async <T>(method: string, endpoint: string, body?: unknown): Promise<T> => {
    if (method === 'GET' && endpoint === '/api/overview') {
      return { profiles: [...this.profiles.values()] } as T;
    }
    if (method === 'POST' && endpoint === '/api/wizard') {
      const { provider } = body as { provider: ProviderId };
      const profile = this.addPending(provider, new Date().toISOString());
      return this.wizardState(profile) as T;
    }
    const state = /^\/api\/wizard\/([^/]+)$/.exec(endpoint);
    if (method === 'GET' && state) {
      return this.wizardState(this.mustGet(state[1] as string)) as T;
    }
    const confirm = /^\/api\/wizard\/([^/]+)\/confirm$/.exec(endpoint);
    if (method === 'POST' && confirm) {
      const profile = this.mustGet(confirm[1] as string);
      if (!this.credentialed.has(profile.home)) {
        throw new ApiRequestError('No credentials found', 409, 'no-credentials');
      }
      const { label } = body as { label: string };
      if (this.takenLabels.has(label)) {
        throw new ApiRequestError(`Label "${label}" is already in use`, 409, 'label-taken');
      }
      const active = { ...profile, label, identity: this.identity, status: 'active' as const };
      this.profiles.set(profile.id, active);
      return active as T;
    }
    throw new ApiRequestError(`${method} ${endpoint} failed with 404`, 404, 'not-found');
  };

  private wizardState(profile: Profile) {
    const credentialsFound = this.credentialed.has(profile.home);
    return {
      profile,
      loginCommand: `LOGIN ${profile.home}`,
      credentialsFound,
      identity: credentialsFound ? this.identity : null,
      suggestedLabel: this.identity?.account?.split('@')[0] ?? `${profile.provider}-1`,
    };
  }

  private mustGet(id: string): Profile {
    const profile = this.profiles.get(id);
    if (!profile) throw new ApiRequestError('Profile not found', 404, 'not-found');
    return profile;
  }
}

interface Harness {
  daemon: FakeDaemon;
  deps: ProfileAddDeps;
  logs: string[];
  logins: Array<{ argv: string[]; env: Record<string, string> }>;
}

function makeHarness(options: { loginSucceeds?: boolean; loginExitCode?: number } = {}): Harness {
  const daemon = new FakeDaemon();
  const logs: string[] = [];
  const logins: Harness['logins'] = [];
  const deps: ProfileAddDeps = {
    api: daemon.api,
    runLogin: async (argv, env) => {
      logins.push({ argv, env });
      if (options.loginSucceeds !== false) {
        const home = Object.values(env)[0] as string;
        daemon.credentialed.add(home);
      }
      return options.loginExitCode ?? 0;
    },
    log: (line) => logs.push(line),
    sleep: async () => {},
  };
  return { daemon, deps, logs, logins };
}

describe('runProfileAdd', () => {
  it('creates a pending profile, runs the provider login with its home env, and confirms', async () => {
    const { daemon, deps, logs, logins } = makeHarness();

    await runProfileAdd(deps, { action: 'add', provider: 'claude', fresh: false, loginArgs: [] });

    expect(logins).toHaveLength(1);
    expect(logins[0]?.argv).toEqual(['claude']);
    expect(logins[0]?.env).toEqual({ CLAUDE_CONFIG_DIR: '/data/homes/pending-1' });

    const profile = [...daemon.profiles.values()][0];
    expect(profile).toMatchObject({ status: 'active', label: 'alice' });
    expect(logs.join('\n')).toContain('profile "alice" added (alice@example.test)');
  });

  it('appends provider login arguments and uses the codex argv', async () => {
    const { deps, logins } = makeHarness();

    await runProfileAdd(deps, {
      action: 'add',
      provider: 'codex',
      label: 'work',
      fresh: false,
      loginArgs: ['--device-auth'],
    });

    expect(logins[0]?.argv).toEqual(['codex', 'login', '--device-auth']);
    expect(logins[0]?.env).toEqual({ CODEX_HOME: '/data/homes/pending-1' });
  });

  it('prefers the explicit label and reports a taken one with a hint', async () => {
    const { daemon, deps } = makeHarness();
    daemon.takenLabels.add('work');

    await expect(
      runProfileAdd(deps, {
        action: 'add',
        provider: 'claude',
        label: 'work',
        fresh: false,
        loginArgs: [],
      }),
    ).rejects.toThrow('Label "work" is already in use — pass a different one with --label');
  });

  it('activates with the suggested fallback label when no identity is detectable', async () => {
    const { daemon, deps } = makeHarness();
    daemon.identity = null; // e.g. codex API-key login: auth.json without id_token

    await runProfileAdd(deps, { action: 'add', provider: 'codex', fresh: false, loginArgs: [] });

    const profile = [...daemon.profiles.values()][0];
    expect(profile).toMatchObject({ status: 'active', label: 'codex-1' });
  });

  it('keeps the pending profile and explains how to retry when the login yields no credentials', async () => {
    const { daemon, deps } = makeHarness({ loginSucceeds: false, loginExitCode: 130 });

    await expect(
      runProfileAdd(deps, { action: 'add', provider: 'claude', fresh: false, loginArgs: [] }),
    ).rejects.toThrow(/no credentials found .*\(login exited with code 130\)/);

    const profile = [...daemon.profiles.values()][0];
    expect(profile?.status).toBe('pending'); // never silently deleted
    await expect(
      runProfileAdd(deps, { action: 'add', provider: 'claude', fresh: false, loginArgs: [] }),
    ).rejects.toBeInstanceOf(CliError);
  });

  it('resumes the newest pending profile instead of creating another', async () => {
    const { daemon, deps, logs } = makeHarness();
    daemon.addPending('claude', '2026-01-01T00:00:00.000Z');
    const newest = daemon.addPending('claude', '2026-02-01T00:00:00.000Z');
    daemon.addPending('codex', '2026-03-01T00:00:00.000Z'); // other provider — ignored

    await runProfileAdd(deps, { action: 'add', provider: 'claude', fresh: false, loginArgs: [] });

    expect(logs.join('\n')).toContain(`resuming pending profile ${newest.id}`);
    expect(daemon.profiles.get(newest.id)?.status).toBe('active');
    // No extra claude pending profile was created.
    const claudeProfiles = [...daemon.profiles.values()].filter((p) => p.provider === 'claude');
    expect(claudeProfiles).toHaveLength(2);
  });

  it('skips the login entirely when a resumed profile already has credentials', async () => {
    const { daemon, deps, logins } = makeHarness();
    const pending = daemon.addPending('claude', '2026-01-01T00:00:00.000Z');
    daemon.credentialed.add(pending.home);

    await runProfileAdd(deps, { action: 'add', provider: 'claude', fresh: false, loginArgs: [] });

    expect(logins).toHaveLength(0);
    expect(daemon.profiles.get(pending.id)?.status).toBe('active');
  });

  it('creates a fresh profile with --new even when a pending one exists', async () => {
    const { daemon, deps } = makeHarness();
    const old = daemon.addPending('claude', '2026-01-01T00:00:00.000Z');

    await runProfileAdd(deps, { action: 'add', provider: 'claude', fresh: true, loginArgs: [] });

    expect(daemon.profiles.get(old.id)?.status).toBe('pending');
    expect(
      [...daemon.profiles.values()].some((p) => p.id !== old.id && p.status === 'active'),
    ).toBe(true);
  });

  it('never exposes the daemon token to the login process or the output', async () => {
    const { daemon, deps, logs, logins } = makeHarness();

    await runProfileAdd(deps, { action: 'add', provider: 'claude', fresh: false, loginArgs: [] });

    const output = logs.join('\n');
    expect(output).not.toContain(daemon.token);
    expect(output.toLowerCase()).not.toContain('bearer');
    for (const login of logins) {
      expect(JSON.stringify(login.env)).not.toContain(daemon.token);
    }
  });
});
