import { describe, expect, it } from 'vitest';
import type { Profile } from '@apm/shared';
import {
  CliError,
  parseCommand,
  parseProfileArgv,
  parseProfilesArgv,
  parseRunArgv,
  parseTargetsArgv,
  parseToolsArgv,
  resolveProfile,
} from './parse.js';

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: 'claude-work',
    provider: 'claude',
    label: 'work',
    home: '/tmp/home',
    homeKind: 'external',
    identity: null,
    status: 'active',
    statusReason: null,
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('parseRunArgv', () => {
  it('takes both positionals and passes the rest verbatim', () => {
    expect(parseRunArgv(['work', 'claude'])).toEqual({
      ephemeral: false,
      profile: 'work',
      app: 'claude',
      args: [],
    });
    expect(parseRunArgv(['work', 'claude', '--resume', '-p', 'hi'])).toEqual({
      profile: 'work',
      app: 'claude',
      args: ['--resume', '-p', 'hi'],
      ephemeral: false,
    });
  });

  it('accepts one target flag before the existing positionals', () => {
    expect(parseRunArgv(['--target', 'workstation', 'work', 'claude', '--resume'])).toEqual({
      target: 'workstation',
      ephemeral: false,
      profile: 'work',
      app: 'claude',
      args: ['--resume'],
    });
  });

  it('accepts remote cwd and connection-bound lifecycle flags in any option order', () => {
    expect(
      parseRunArgv([
        '--ephemeral',
        '--cwd',
        '/srv/work tree',
        '--target',
        'workstation',
        'work',
        'codex',
      ]),
    ).toEqual({
      target: 'workstation',
      cwd: '/srv/work tree',
      ephemeral: true,
      profile: 'work',
      app: 'codex',
      args: [],
    });
  });

  it('accepts `--` after the profile and after the app', () => {
    expect(parseRunArgv(['work', '--', 'claude', '--resume'])).toEqual({
      profile: 'work',
      app: 'claude',
      args: ['--resume'],
      ephemeral: false,
    });
    expect(parseRunArgv(['work', 'claude', '--', '--resume'])).toEqual({
      profile: 'work',
      app: 'claude',
      args: ['--resume'],
      ephemeral: false,
    });
    expect(parseRunArgv(['work', '--', 'claude', '--', '--resume'])).toEqual({
      profile: 'work',
      app: 'claude',
      args: ['--resume'],
      ephemeral: false,
    });
  });

  it('leaves any further `--` to the app', () => {
    expect(parseRunArgv(['work', 'bash', '--', '-c', '--', 'echo hi']).args).toEqual([
      '-c',
      '--',
      'echo hi',
    ]);
  });

  it('requires both positionals', () => {
    expect(() => parseRunArgv([])).toThrow(CliError);
    expect(() => parseRunArgv(['work'])).toThrow(/requires <app>/);
    expect(() => parseRunArgv(['work', '--'])).toThrow(/requires <app>/);
  });

  it('rejects flags in positional slots unless escaped', () => {
    expect(() => parseRunArgv(['--port', '1', 'claude'])).toThrow(/unknown flag: --port/);
    expect(() => parseRunArgv(['work', '--resume'])).toThrow(/unknown flag: --resume/);
    expect(parseRunArgv(['work', '--', '--weird-app']).app).toBe('--weird-app');
  });

  it('keeps old flag errors and rejects an incomplete target option clearly', () => {
    expect(() => parseRunArgv(['--port', '1', 'claude'])).toThrow(
      'unknown flag: --port (apm flags go before the positionals)',
    );
    expect(() => parseRunArgv(['work', '--target', 'box', 'claude'])).toThrow(
      'unknown flag: --target (apm flags go before the positionals)',
    );
    expect(() => parseRunArgv(['--target'])).toThrow('--target requires <target>');
    expect(() => parseRunArgv(['--target', '--', 'work', 'claude'])).toThrow(
      '--target requires <target>',
    );
    expect(() => parseRunArgv(['--cwd'])).toThrow('--cwd requires <path>');
    expect(() => parseRunArgv(['--cwd', '--ephemeral', 'work', 'claude'])).toThrow(
      '--cwd requires <path>',
    );
  });
});

describe('parseTargetsArgv', () => {
  it('parses list and target-profile JSON modes', () => {
    expect(parseTargetsArgv([])).toEqual({ json: false });
    expect(parseTargetsArgv(['--json'])).toEqual({ json: true });
    expect(parseTargetsArgv(['--profiles', 'dev-box', '--json'])).toEqual({
      json: true,
      profilesTarget: 'dev-box',
    });
  });

  it('rejects missing, repeated, and unknown options', () => {
    expect(() => parseTargetsArgv(['--profiles'])).toThrow('--profiles requires <target>');
    expect(() => parseTargetsArgv(['--profiles', 'one', '--profiles', 'two'])).toThrow(
      '--profiles may be supplied only once',
    );
    expect(() => parseTargetsArgv(['--refresh'])).toThrow('unknown targets option');
  });
});

describe('parseToolsArgv', () => {
  it('lists by default and updates exactly one supported provider', () => {
    expect(parseToolsArgv([])).toEqual({ action: 'list' });
    expect(parseToolsArgv(['update', 'codex'])).toEqual({ action: 'update', provider: 'codex' });
    expect(() => parseToolsArgv(['update', 'gemini'])).toThrow(/requires claude, codex, or cursor/);
    expect(() => parseToolsArgv(['update', 'codex', 'latest'])).toThrow(
      /unexpected argument: latest/,
    );
  });
});

describe('parseProfileArgv', () => {
  it('parses the minimal add invocation', () => {
    expect(parseProfileArgv(['add', 'claude'])).toEqual({
      action: 'add',
      provider: 'claude',
      fresh: false,
      loginArgs: [],
    });
  });

  it('parses a cursor add invocation', () => {
    expect(parseProfileArgv(['add', 'cursor'])).toEqual({
      action: 'add',
      provider: 'cursor',
      fresh: false,
      loginArgs: [],
    });
  });

  it('takes a label and a fresh-home flag', () => {
    expect(parseProfileArgv(['add', 'codex', '--label', 'work', '--new'])).toEqual({
      action: 'add',
      provider: 'codex',
      label: 'work',
      fresh: true,
      loginArgs: [],
    });
  });

  it('passes everything after `--` to the provider login verbatim', () => {
    expect(parseProfileArgv(['add', 'codex', '--', '--device-auth', '--new'])).toEqual({
      action: 'add',
      provider: 'codex',
      fresh: false,
      loginArgs: ['--device-auth', '--new'],
    });
  });

  it('rejects missing or unknown subcommands and providers', () => {
    expect(() => parseProfileArgv([])).toThrow(/profile requires a subcommand/);
    expect(() => parseProfileArgv(['remove', 'claude'])).toThrow(/unknown profile subcommand/);
    expect(() => parseProfileArgv(['add'])).toThrow(/requires a provider/);
    expect(() => parseProfileArgv(['add', 'gemini'])).toThrow(
      'unknown provider: gemini (expected claude or codex or cursor)',
    );
  });

  it('rejects bad flags with a pointer to the `--` escape hatch', () => {
    expect(() => parseProfileArgv(['add', 'claude', '--label'])).toThrow(
      /--label requires a value/,
    );
    expect(() => parseProfileArgv(['add', 'codex', '--device-auth'])).toThrow(
      'unknown flag: --device-auth (provider login arguments go after `--`)',
    );
  });

  it('parses the adopt form with --from-target in any flag order', () => {
    expect(
      parseProfileArgv(['add', 'claude', '--from-target', 'dev-box', '--label', 'here', 'work']),
    ).toEqual({
      action: 'adopt',
      provider: 'claude',
      target: 'dev-box',
      remoteProfile: 'work',
      label: 'here',
    });
    expect(parseProfileArgv(['add', 'codex', 'work', '--from-target', 'dev-box'])).toEqual({
      action: 'adopt',
      provider: 'codex',
      target: 'dev-box',
      remoteProfile: 'work',
    });
  });

  it('rejects adopt forms missing a piece or mixing in login options', () => {
    expect(() => parseProfileArgv(['add', 'claude', '--from-target', 'dev-box'])).toThrow(
      /--from-target requires a remote <profile>/,
    );
    expect(() => parseProfileArgv(['add', 'claude', 'work'])).toThrow(
      /a remote profile needs --from-target/,
    );
    expect(() =>
      parseProfileArgv(['add', 'claude', '--from-target', 'dev-box', '--new', 'work']),
    ).toThrow(/--from-target does not take --new/);
    expect(() =>
      parseProfileArgv(['add', 'claude', '--from-target', 'dev-box', 'work', '--', '-x']),
    ).toThrow(/--from-target does not take --new or login arguments/);
  });

  it('parses sync-enable with exactly one profile reference', () => {
    expect(parseProfileArgv(['sync-enable', 'work'])).toEqual({
      action: 'sync-enable',
      profile: 'work',
    });
    expect(() => parseProfileArgv(['sync-enable'])).toThrow(/sync-enable requires <profile>/);
    expect(() => parseProfileArgv(['sync-enable', 'work', 'extra'])).toThrow(
      /unexpected argument: extra/,
    );
  });
});

describe('resolveProfile', () => {
  const profiles = [
    makeProfile(),
    makeProfile({ id: 'codex-work', provider: 'codex' }),
    makeProfile({ id: 'cursor-work', provider: 'cursor', label: 'work' }),
    makeProfile({ id: 'claude-personal', label: 'personal' }),
  ];

  it('scopes known provider apps to their provider', () => {
    expect(resolveProfile(profiles, 'work', 'claude').id).toBe('claude-work');
    expect(resolveProfile(profiles, 'work', 'codex').id).toBe('codex-work');
    expect(resolveProfile(profiles, 'work', 'cursor-agent').id).toBe('cursor-work');
    expect(resolveProfile(profiles, 'work', 'cursor').id).toBe('cursor-work');
  });

  it('matches across providers for arbitrary apps when unambiguous', () => {
    expect(resolveProfile(profiles, 'personal', 'bash').id).toBe('claude-personal');
    expect(resolveProfile(profiles, 'personal', 'agent').id).toBe('claude-personal');
  });

  it('refuses to guess when a label exists for several providers', () => {
    expect(() => resolveProfile(profiles, 'work', 'bash')).toThrow(/ambiguous/);
    expect(() => resolveProfile(profiles, 'work', 'bash')).toThrow(/claude, codex, cursor/);
  });

  it('disambiguates with a provider-qualified name', () => {
    expect(resolveProfile(profiles, 'cursor:work', 'bash').id).toBe('cursor-work');
    expect(resolveProfile(profiles, 'claude:work', 'bash').id).toBe('claude-work');
    expect(() => resolveProfile(profiles, 'codex:work', 'claude')).toThrow(
      /claude needs a claude profile, not codex/,
    );
    expect(() => resolveProfile(profiles, 'nonprovider:work', 'bash')).toThrow(/no profile named/);
  });

  it('accepts a profile id and is case-insensitive on labels', () => {
    expect(resolveProfile(profiles, 'codex-work', 'bash').id).toBe('codex-work');
    expect(resolveProfile(profiles, 'PERSONAL', 'bash').id).toBe('claude-personal');
  });

  it('lists the known profiles when nothing matches', () => {
    expect(() => resolveProfile(profiles, 'nope', 'claude')).toThrow(/no profile named "nope"/);
    expect(() => resolveProfile(profiles, 'nope', 'claude')).toThrow(/personal, work/);
  });
});

describe('parseCommand', () => {
  it('defaults to start for a bare invocation and for leading flags', () => {
    expect(parseCommand([])).toEqual({ command: 'start', argv: [] });
    expect(parseCommand(['--no-open'])).toEqual({ command: 'start', argv: ['--no-open'] });
    expect(parseCommand(['--port', '5000'])).toEqual({
      command: 'start',
      argv: ['--port', '5000'],
    });
  });

  it('splits the command word off its arguments', () => {
    expect(parseCommand(['start', '--foreground'])).toEqual({
      command: 'start',
      argv: ['--foreground'],
    });
    expect(parseCommand(['run', 'work', 'claude'])).toEqual({
      command: 'run',
      argv: ['work', 'claude'],
    });
    expect(parseCommand(['profiles', '--json'])).toEqual({
      command: 'profiles',
      argv: ['--json'],
    });
    expect(parseCommand(['url'])).toEqual({ command: 'url', argv: [] });
    expect(parseCommand(['status'])).toEqual({ command: 'status', argv: [] });
  });

  it('keeps help flags as commands rather than start flags', () => {
    expect(parseCommand(['-h']).command).toBe('-h');
    expect(parseCommand(['--help']).command).toBe('--help');
    expect(parseCommand(['help']).command).toBe('help');
  });

  it('rejects unknown commands with the usage text', () => {
    expect(() => parseCommand(['nope'])).toThrow(CliError);
    expect(() => parseCommand(['nope'])).toThrow(/unknown command: nope/);
    expect(() => parseCommand(['nope'])).toThrow(/apm url/);
    expect(() => parseCommand(['pair'])).toThrow(/unknown command: pair/);
  });
});

describe('parseProfilesArgv', () => {
  it('accepts the output and refresh flags in either order', () => {
    expect(parseProfilesArgv([])).toEqual({ json: false, refresh: false });
    expect(parseProfilesArgv(['--json', '--refresh'])).toEqual({ json: true, refresh: true });
    expect(parseProfilesArgv(['--refresh', '--json'])).toEqual({ json: true, refresh: true });
  });

  it('rejects unknown flags and positionals', () => {
    expect(() => parseProfilesArgv(['--pretty'])).toThrow(/unknown profiles option/);
    expect(() => parseProfilesArgv(['work'])).toThrow(/usage: apm profiles/);
  });
});
