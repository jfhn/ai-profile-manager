/**
 * Pure argv/profile resolution for the CLI — no I/O, so it can be unit tested.
 *
 * Grammar: `apm run [options] <profile> <app> [args...]`. Both
 * positionals are always required (the app decides the provider, so profile
 * names are only unique per provider). Everything after <app> is passed to the
 * app verbatim; a literal `--` directly after <profile> or after <app> is an
 * optional escape hatch.
 */
import { isProviderId, PROVIDER_IDS, type ProviderId } from '@apm/shared';

/** An error meant for the user, printed as `apm: <message>`. */
export class CliError extends Error {}

export const USAGE =
  `usage: apm [start|profile|profiles|targets|run|pair|attach|sessions|status|url|stop]\n` +
  `  apm [start] [--port N] [--no-open] [--foreground]   start or reuse the daemon, open the UI\n` +
  `  apm url                                             print the authenticated URL, open nothing\n` +
  `  apm profile add <claude|codex> [--label <label>] [--new] [-- login-args...]\n` +
  `                                                      log in to a fresh managed profile\n` +
  `  apm profiles [--json] [--refresh]                   list profiles and provider defaults\n` +
  `  apm targets [--json] [--profiles <target>]          list targets or one target's profiles\n` +
  `  apm run [--target <target>] [--cwd <path>] [--ephemeral] <profile> <app> [args...]\n` +
  `                                                      run an app bound to a profile\n` +
  `  apm pair [<instance-id>]                            pair with a running managed T3 instance\n` +
  `  apm attach <session>                                attach to a running session\n` +
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
  'pair',
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

export interface PairInvocation {
  /** Exact managed-instance id; omitted only when one running instance exists. */
  instanceId?: string;
}

const PAIR_USAGE = 'usage: apm pair [<instance-id>]';

export function parsePairArgv(argv: string[]): PairInvocation {
  const instanceId = argv[0];
  if (instanceId?.startsWith('-')) {
    throw new CliError(`unknown pair option: ${instanceId}\n${PAIR_USAGE}`);
  }
  if (argv.length > 1) throw new CliError(`pair takes at most one instance id\n${PAIR_USAGE}`);
  return instanceId === undefined ? {} : { instanceId };
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

/** Known provider apps — these scope the profile lookup to one provider. */
export const APP_PROVIDERS: Record<string, ProviderId> = {
  claude: 'claude',
  codex: 'codex',
};

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

const PROFILE_USAGE =
  'usage: apm profile add <claude|codex> [--label <label>] [--new] [-- login-args...]';

export function parseProfileArgv(argv: string[]): ProfileAddInvocation {
  const rest = [...argv];

  const action = rest.shift();
  if (action === undefined) throw new CliError(`profile requires a subcommand\n${PROFILE_USAGE}`);
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
    } else {
      throw new CliError(
        `unknown flag: ${arg} (provider login arguments go after \`--\`)\n${PROFILE_USAGE}`,
      );
    }
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
  const provider = APP_PROVIDERS[app];
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
        `run it through a provider app (e.g. apm run ${name} ${providers[0]} ...), ` +
        `pass the profile id, or use unique labels`,
    );
  }

  return first;
}
