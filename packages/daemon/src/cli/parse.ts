/**
 * Pure argv/profile resolution for the CLI — no I/O, so it can be unit tested.
 *
 * Grammar: `apm run <profile> <app> [args...]`. Both positionals are always
 * required (the app decides the provider, so profile names are only unique per
 * provider). Everything after <app> is passed to the app verbatim; a literal
 * `--` directly after <profile> or after <app> is an optional escape hatch.
 */
import type { Profile, ProviderId } from '@apm/shared';

/** An error meant for the user, printed as `apm: <message>`. */
export class CliError extends Error {}

export const USAGE =
  `usage: apm [start|run|attach|sessions|status|url|stop]\n` +
  `  apm [start] [--port N] [--no-open] [--foreground]   start or reuse the daemon, open the UI\n` +
  `  apm url                                             print the authenticated URL, open nothing\n` +
  `  apm run <profile> <app> [args...]                   run an app bound to a profile\n` +
  `  apm attach <session>                                attach to a running session\n` +
  `  apm sessions | status | stop`;

/** Everything `main` dispatches on; `__daemon` is the internal detached start. */
const COMMANDS = new Set([
  'start',
  '__daemon',
  'run',
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
  profile: string;
  app: string;
  args: string[];
}

const RUN_USAGE = 'usage: apm run <profile> <app> [args...]';

/** Known provider apps — these scope the profile lookup to one provider. */
export const APP_PROVIDERS: Record<string, ProviderId> = {
  claude: 'claude',
  codex: 'codex',
};

export function parseRunArgv(argv: string[]): RunInvocation {
  const rest = [...argv];

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

  return { profile, app, args: rest };
}

/**
 * Resolve a profile name for `apm run`. Known apps scope the lookup to their
 * provider; anything else searches every provider and refuses to guess when
 * the same label exists twice.
 */
export function resolveProfile(profiles: Profile[], name: string, app: string): Profile {
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
