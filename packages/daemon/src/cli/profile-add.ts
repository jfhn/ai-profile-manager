/**
 * Headless profile onboarding (`apm profile add`) — drives the daemon's
 * wizard API and runs the provider login in the invoking terminal.
 *
 * The daemon owns the lifecycle (managed home, credential detection,
 * activation); this module only orchestrates it: start or resume a pending
 * profile, spawn the provider's own login command bound to the managed home,
 * poll until credentials appear, then confirm with a label. Provider
 * authentication stays with the provider CLI — including any browser or
 * device step it requires.
 *
 * All I/O comes in through ProfileAddDeps so the flow is deterministic in
 * tests and structurally unable to leak the daemon token or credential
 * contents into output.
 */
import { getAdapter } from '@apm/collectors';
import type { OverviewResponse, Profile, WizardStateResponse } from '@apm/shared';
import { CliError, type ProfileAddInvocation } from './parse.js';

/** A daemon API failure that callers may want to branch on. */
export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
  ) {
    super(message);
  }
}

export interface ProfileAddDeps {
  /** Authenticated daemon request; throws ApiRequestError on a non-2xx reply. */
  api<T>(method: string, endpoint: string, body?: unknown): Promise<T>;
  /** Run the provider login in the invoking terminal; resolves with its exit code. */
  runLogin(argv: string[], env: Record<string, string>): Promise<number>;
  log(line: string): void;
  sleep(ms: number): Promise<void>;
}

const CREDENTIAL_POLL_INTERVAL_MS = 500;
const CREDENTIAL_POLL_TIMEOUT_MS = 10_000;

export async function runProfileAdd(
  deps: ProfileAddDeps,
  invocation: ProfileAddInvocation,
): Promise<void> {
  const adapter = getAdapter(invocation.provider);
  let state = await startOrResume(deps, invocation);
  const profileId = state.profile.id;

  if (state.credentialsFound) {
    deps.log('credentials already present — confirming the profile');
  } else {
    deps.log(`Log in to ${adapter.displayName} in this terminal.`);
    deps.log(`Profile home: ${state.profile.home}`);
    deps.log('If the provider CLI stays open after the login completes, exit it to continue.');
    deps.log('');
    const argv = [...adapter.loginArgv(), ...invocation.loginArgs];
    // The login command is the provider CLI itself, so it takes the app-only
    // vars directly.
    const binding = adapter.env(state.profile.home);
    const exitCode = await deps.runLogin(argv, { ...binding.session, ...binding.appOnly?.env });
    state = await waitForCredentials(deps, profileId);
    if (!state.credentialsFound) {
      const exitNote = exitCode === 0 ? '' : ` (login exited with code ${exitCode})`;
      throw new CliError(
        `no credentials found in the profile home${exitNote}\n` +
          `the pending profile is kept — rerun \`apm profile add ${invocation.provider}\` to ` +
          `retry (add --new for a fresh home), or remove it from the dashboard`,
      );
    }
  }

  if (state.identity?.account) deps.log(`detected account: ${state.identity.account}`);

  const label = invocation.label ?? state.suggestedLabel;
  let profile: Profile;
  try {
    profile = await deps.api<Profile>('POST', `/api/wizard/${profileId}/confirm`, { label });
  } catch (error: unknown) {
    if (error instanceof ApiRequestError && error.code === 'label-taken') {
      throw new CliError(`${error.message} — pass a different one with --label`);
    }
    throw error;
  }

  const identity = profile.identity?.account;
  deps.log(`profile "${profile.label}" added${identity ? ` (${identity})` : ''}`);
  const defaultApp = adapter.loginArgv()[0] ?? profile.provider;
  deps.log(`run it with: apm run ${profile.label} ${defaultApp}`);
}

/**
 * Resume the newest pending profile for the provider so a failed or
 * interrupted login retries into the same managed home instead of piling up
 * abandoned ones; `--new` opts out.
 */
async function startOrResume(
  deps: ProfileAddDeps,
  invocation: ProfileAddInvocation,
): Promise<WizardStateResponse> {
  if (!invocation.fresh) {
    const overview = await deps.api<OverviewResponse>('GET', '/api/overview');
    const pending = overview.profiles
      .filter((profile) => profile.provider === invocation.provider && profile.status === 'pending')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (pending) {
      deps.log(`resuming pending profile ${pending.id} (use --new for a fresh one)`);
      return deps.api<WizardStateResponse>('GET', `/api/wizard/${pending.id}`);
    }
  }
  return deps.api<WizardStateResponse>('POST', '/api/wizard', { provider: invocation.provider });
}

/** The provider CLI writes credentials before exiting; the timeout is slack, not a wait. */
async function waitForCredentials(
  deps: ProfileAddDeps,
  profileId: string,
): Promise<WizardStateResponse> {
  let attempts = Math.ceil(CREDENTIAL_POLL_TIMEOUT_MS / CREDENTIAL_POLL_INTERVAL_MS);
  for (;;) {
    const state = await deps.api<WizardStateResponse>('GET', `/api/wizard/${profileId}`);
    if (state.credentialsFound || --attempts <= 0) return state;
    await deps.sleep(CREDENTIAL_POLL_INTERVAL_MS);
  }
}
