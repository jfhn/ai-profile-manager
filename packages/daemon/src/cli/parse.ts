/**
 * Pure argv/profile resolution for the CLI — no I/O, so it can be unit tested.
 *
 * Grammar: `apm run [options] <profile> <app> [args...]`. Both
 * positionals are always required (the app decides the provider, so profile
 * names are only unique per provider). Everything after <app> is passed to the
 * app verbatim; a literal `--` directly after <profile> or after <app> is an
 * optional escape hatch.
 */
import { APP_PROVIDERS, isProviderId, PROVIDER_IDS, type ProviderId } from '@apm/shared';

/** An error meant for the user, printed as `apm: <message>`. */
export class CliError extends Error {}

export const USAGE =
  `usage: apm [start|profile|profiles|targets|run|attach|sessions|status|url|stop]\n` +
  `  apm [start] [--port N] [--no-open] [--foreground]   start or reuse the daemon, open the UI\n` +
  `  apm url                                             print the authenticated URL, open nothing\n` +
  `  apm profile add <claude|codex|cursor> [--label <label>] [--new] [-- login-args...]\n` +
  `                                                      log in to a fresh managed profile\n` +
  `  apm profile add <claude|codex> --from-target <target> [--label <label>] <profile>\n` +
  `                                                      adopt a synced replica of a remote profile\n` +
  `  apm profile sync-enable <profile>                   make a profile a credential-sync owner\n` +
  `  apm profiles [--json] [--refresh]                   list profiles and provider defaults\n` +
  `  apm targets [--json] [--profiles <target>]          list targets or one target's profiles\n` +
  `  apm run [--target <target>] [--cwd <path>] [--ephemeral] <profile> <app> [args...]\n` +
  `                                                      run an app bound to a profile\n` +
  `  apm attach <session>                                attach (detach: Ctrl-] or Ctrl-5)\n` +
  `  apm sessions | status | stop`;

/** Everything `main` dispatches on; `__daemon` is the internal detached start. */
const COMMANDS = new Set([
  'start',
  '__daemon',
  '__target-agent',
  'profile',
  'run',
  'profiles',
  'targets',
  'attach',
  'sessions',
  'status',
  'url',
  'stop',
  'help',
  '--help',
  '-h',
]);

export interface CommandInvocation {
  command: string;
  /** Arguments for the command, with the command word removed. */
  argv: string[];
}

/**
 * Split `process.argv` into a command and its arguments. `start` is the
 * default, so a bare `apm` and a leading flag (`apm --no-open`) both mean
 * "start or reuse the daemon".
 */
export function parseCommand(argv: string[]): CommandInvocation {
  const first = argv[0];
  const isHelpFlag = first === '-h' || first === '--help';
  if (first === undefined || (first.startsWith('-') && !isHelpFlag)) {
    return { command: 'start', argv };
  }
  if (!COMMANDS.has(first)) throw new CliError(`unknown command: ${first}\n${USAGE}`);
  return { command: first, argv: argv.slice(1) };
}

export interface RunInvocation {
  target?: string;
  cwd?: string;
  ephemeral: boolean;
  profile: string;
  app: string;
  args: string[];
}

export interface ProfilesInvocation {
  json: boolean;
  refresh: boolean;
}

export interface TargetsInvocation {
  json: boolean;
  profilesTarget?: string;
}

const PROFILES_USAGE = 'usage: apm profiles [--json] [--refresh]';

export function parseProfilesArgv(argv: string[]): ProfilesInvocation {
  const invocation: ProfilesInvocation = { json: false, refresh: false };
  for (const arg of argv) {
    if (arg === '--json') invocation.json = true;
    else if (arg === '--refresh') invocation.refresh = true;
    else throw new CliError(`unknown profiles option: ${arg}\n${PROFILES_USAGE}`);
  }
  return invocation;
}

const TARGETS_USAGE = 'usage: apm targets [--json] [--profiles <target>]';

export function parseTargetsArgv(argv: string[]): TargetsInvocation {
  const invocation: TargetsInvocation = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      invocation.json = true;
      continue;
    }
    if (arg === '--profiles') {
      const target = argv[index + 1];
      if (target === undefined || target.startsWith('-')) {
        throw new CliError(`--profiles requires <target>\n${TARGETS_USAGE}`);
      }
      if (invocation.profilesTarget !== undefined) {
        throw new CliError(`--profiles may be supplied only once\n${TARGETS_USAGE}`);
      }
      invocation.profilesTarget = target;
      index += 1;
      continue;
    }
    throw new CliError(`unknown targets option: ${arg}\n${TARGETS_USAGE}`);
  }
  return invocation;
}

const RUN_USAGE =
  'usage: apm run [--target <target>] [--cwd <path>] [--ephemeral] <profile> <app> [args...]';

export function parseRunArgv(argv: string[]): RunInvocation {
  const rest = [...argv];
  let target: string | undefined;
  let cwd: string | undefined;
  let ephemeral = false;

  while (rest[0]?.startsWith('-') && rest[0] !== '--') {
    const option = rest.shift();
    if (option === '--target') {
      target = rest.shift();
      if (target === undefined || target.startsWith('-')) {
        throw new CliError(`--target requires <target>\n${RUN_USAGE}`);
      }
      continue;
    }
    if (option === '--cwd') {
      cwd = rest.shift();
      if (cwd === undefined || cwd.startsWith('-')) {
        throw new CliError(`--cwd requires <path>\n${RUN_USAGE}`);
      }
      continue;
    }
    if (option === '--ephemeral') {
      ephemeral = true;
      continue;
    }
    throw new CliError(
      `unknown flag: ${option} (apm flags go before the positionals)\n${RUN_USAGE}`,
    );
  }

  const profile = rest.shift();
  if (profile === undefined) throw new CliError(`run requires <profile> and <app>\n${RUN_USAGE}`);
  if (profile.startsWith('-')) {
    throw new CliError(
      `unknown flag: ${profile} (apm flags go before the positionals)\n${RUN_USAGE}`,
    );
  }

  let escaped = false;
  if (rest[0] === '--') {
    rest.shift();
    escaped = true;
  }

  const app = rest.shift();
  if (app === undefined) throw new CliError(`run requires <app>\n${RUN_USAGE}`);
  if (app.startsWith('-') && !escaped) {
    throw new CliError(`unknown flag: ${app} (apm flags go before the positionals)\n${RUN_USAGE}`);
  }

  // A single `--` here separates apm's grammar from the app's own flags; any
  // further `--` belongs to the app.
  if (rest[0] === '--') rest.shift();

  return {
    ...(target === undefined ? {} : { target }),
    ...(cwd === undefined ? {} : { cwd }),
    ephemeral,
    profile,
    app,
    args: rest,
  };
}

// ------------------------------------------------------------ profile add --

export interface ProfileAddInvocation {
  action: 'add';
  provider: ProviderId;
  /** Explicit label; undefined means use the wizard's suggestion. */
  label?: string;
  /** True forces a fresh pending profile instead of resuming an existing one. */
  fresh: boolean;
  /** Extra arguments appended verbatim to the provider's login command. */
  loginArgs: string[];
}

/** `apm profile add <provider> --from-target <target> <profile>` — adopt a replica. */
export interface ProfileAdoptInvocation {
  action: 'adopt';
  provider: ProviderId;
  target: string;
  /** Remote profile id or label, resolved against the target's profile list. */
  remoteProfile: string;
  /** Local label; defaults to the remote profile's label. */
  label?: string;
}

/** `apm profile sync-enable <profile>` — make a local profile a sync owner. */
export interface ProfileSyncEnableInvocation {
  action: 'sync-enable';
  /** Local profile id or label. */
  profile: string;
}

export type ProfileInvocation =
  ProfileAddInvocation | ProfileAdoptInvocation | ProfileSyncEnableInvocation;

const PROFILE_USAGE =
  'usage: apm profile add <claude|codex|cursor> [--label <label>] [--new] [-- login-args...]\n' +
  '       apm profile add <claude|codex> --from-target <target> [--label <label>] <profile>\n' +
  '       apm profile sync-enable <profile>';

export function parseProfileArgv(argv: string[]): ProfileInvocation {
  const rest = [...argv];

  const action = rest.shift();
  if (action === undefined) throw new CliError(`profile requires a subcommand\n${PROFILE_USAGE}`);
  if (action === 'sync-enable') {
    const profile = rest.shift();
    if (profile === undefined || profile.startsWith('-')) {
      throw new CliError(`sync-enable requires <profile>\n${PROFILE_USAGE}`);
    }
    if (rest.length > 0) {
      throw new CliError(`unexpected argument: ${rest[0]}\n${PROFILE_USAGE}`);
    }
    return { action: 'sync-enable', profile };
  }
  if (action !== 'add') {
    throw new CliError(`unknown profile subcommand: ${action}\n${PROFILE_USAGE}`);
  }

  const provider = rest.shift();
  if (provider === undefined || provider.startsWith('-')) {
    throw new CliError(`profile add requires a provider\n${PROFILE_USAGE}`);
  }
  if (!isProviderId(provider)) {
    throw new CliError(`unknown provider: ${provider} (expected ${PROVIDER_IDS.join(' or ')})`);
  }

  let label: string | undefined;
  let fresh = false;
  let fromTarget: string | undefined;
  let remoteProfile: string | undefined;
  const loginArgs: string[] = [];

  while (rest.length > 0) {
    const arg = rest.shift() as string;
    if (arg === '--') {
      // Everything after `--` belongs to the provider's login command.
      loginArgs.push(...rest);
      break;
    }
    if (arg === '--label') {
      label = rest.shift();
      if (label === undefined || label.startsWith('-')) {
        throw new CliError(`--label requires a value\n${PROFILE_USAGE}`);
      }
    } else if (arg === '--new') {
      fresh = true;
    } else if (arg === '--from-target') {
      fromTarget = rest.shift();
      if (fromTarget === undefined || fromTarget.startsWith('-')) {
        throw new CliError(`--from-target requires <target>\n${PROFILE_USAGE}`);
      }
    } else if (!arg.startsWith('-') && remoteProfile === undefined) {
      remoteProfile = arg;
    } else {
      throw new CliError(
        `unknown flag: ${arg} (provider login arguments go after \`--\`)\n${PROFILE_USAGE}`,
      );
    }
  }

  if (fromTarget === undefined && remoteProfile !== undefined) {
    throw new CliError(
      `unexpected argument: ${remoteProfile} (a remote profile needs --from-target)\n${PROFILE_USAGE}`,
    );
  }
  if (fromTarget !== undefined) {
    if (remoteProfile === undefined) {
      throw new CliError(`--from-target requires a remote <profile>\n${PROFILE_USAGE}`);
    }
    if (fresh || loginArgs.length > 0) {
      throw new CliError(`--from-target does not take --new or login arguments\n${PROFILE_USAGE}`);
    }
    return {
      action: 'adopt',
      provider,
      target: fromTarget,
      remoteProfile,
      ...(label === undefined ? {} : { label }),
    };
  }

  return label === undefined
    ? { action: 'add', provider, fresh, loginArgs }
    : { action: 'add', provider, label, fresh, loginArgs };
}

/** The bit of a profile this resolution needs — a local Profile or a target's summary. */
export interface ResolvableProfile {
  id: string;
  label: string;
  provider: ProviderId;
}

/**
 * Resolve a profile name for `apm run`. Known apps scope the lookup to their
 * provider; anything else searches every provider and refuses to guess when
 * the same label exists twice.
 *
 * The candidate list is always the profiles of one target, so the same rules
 * apply whether they came from this machine or from a remote one.
 */
export function resolveProfile<T extends ResolvableProfile>(
  profiles: T[],
  name: string,
  app: string,
): T {
  const appProvider = APP_PROVIDERS[app]?.provider;

  // A provider-qualified name ("cursor:personal") disambiguates labels shared
  // across providers when the app itself is provider-neutral (bash).
  let qualifier: ProviderId | undefined;
  const colon = name.indexOf(':');
  if (colon > 0 && isProviderId(name.slice(0, colon))) {
    qualifier = name.slice(0, colon) as ProviderId;
    name = name.slice(colon + 1);
  }
  if (qualifier && appProvider && qualifier !== appProvider) {
    throw new CliError(`${app} needs a ${appProvider} profile, not ${qualifier}`);
  }

  const provider = qualifier ?? appProvider;
  const scope = provider ? profiles.filter((profile) => profile.provider === provider) : profiles;

  const byId = scope.find((profile) => profile.id === name);
  if (byId) return byId;

  let matches = scope.filter((profile) => profile.label === name);
  if (matches.length === 0) {
    matches = scope.filter((profile) => profile.label.toLowerCase() === name.toLowerCase());
  }

  const first = matches[0];
  if (first === undefined) {
    const known = scope.map((profile) => profile.label).sort();
    const where = provider ? ` for provider ${provider}` : '';
    const hint = known.length ? `\nknown profiles${where}: ${known.join(', ')}` : '';
    throw new CliError(`no profile named "${name}"${where}${hint}`);
  }

  if (matches.length > 1) {
    const providers = [...new Set(matches.map((profile) => profile.provider))].sort();
    throw new CliError(
      `profile "${name}" is ambiguous (${providers.join(', ')}) — ` +
        `prefix the provider (e.g. apm run ${providers[0]}:${name} ...), ` +
        `pass the profile id, or use unique labels`,
    );
  }

  return first;
}
