import { describe, expect, it } from 'vitest';
import type { Profile } from '@apm/shared';
import {
  CliError,
  parseCommand,
  parsePairArgv,
  parseProfileArgv,
  parseProfilesArgv,
  parseRunArgv,
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
    expect(parseRunArgv(['work', 'claude'])).toEqual({ profile: 'work', app: 'claude', args: [] });
    expect(parseRunArgv(['work', 'claude', '--resume', '-p', 'hi'])).toEqual({
      profile: 'work',
      app: 'claude',
      args: ['--resume', '-p', 'hi'],
    });
  });

  it('accepts one target flag before the existing positionals', () => {
    expect(parseRunArgv(['--target', 'workstation', 'work', 'claude', '--resume'])).toEqual({
      target: 'workstation',
      profile: 'work',
      app: 'claude',
      args: ['--resume'],
    });
  });

  it('accepts `--` after the profile and after the app', () => {
    expect(parseRunArgv(['work', '--', 'claude', '--resume'])).toEqual({
      profile: 'work',
      app: 'claude',
      args: ['--resume'],
    });
    expect(parseRunArgv(['work', 'claude', '--', '--resume'])).toEqual({
      profile: 'work',
      app: 'claude',
      args: ['--resume'],
    });
    expect(parseRunArgv(['work', '--', 'claude', '--', '--resume'])).toEqual({
      profile: 'work',
      app: 'claude',
      args: ['--resume'],
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
      'unknown provider: gemini (expected claude or codex)',
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
});

describe('resolveProfile', () => {
  const profiles = [
    makeProfile(),
    makeProfile({ id: 'codex-work', provider: 'codex' }),
    makeProfile({ id: 'claude-personal', label: 'personal' }),
  ];

  it('scopes known provider apps to their provider', () => {
    expect(resolveProfile(profiles, 'work', 'claude').id).toBe('claude-work');
    expect(resolveProfile(profiles, 'work', 'codex').id).toBe('codex-work');
  });

  it('matches across providers for arbitrary apps when unambiguous', () => {
    expect(resolveProfile(profiles, 'personal', 'bash').id).toBe('claude-personal');
  });

  it('refuses to guess when a label exists for several providers', () => {
    expect(() => resolveProfile(profiles, 'work', 'bash')).toThrow(/ambiguous/);
    expect(() => resolveProfile(profiles, 'work', 'bash')).toThrow(/claude, codex/);
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
    expect(parseCommand(['pair', 'instance-1'])).toEqual({
      command: 'pair',
      argv: ['instance-1'],
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
  });
});

describe('parsePairArgv', () => {
  it('accepts automatic selection or one exact instance id', () => {
    expect(parsePairArgv([])).toEqual({});
    expect(parsePairArgv(['8f73d37e-13dc-49bb-8d92-a611bcff9811'])).toEqual({
      instanceId: '8f73d37e-13dc-49bb-8d92-a611bcff9811',
    });
  });

  it('rejects options and extra selectors', () => {
    expect(() => parsePairArgv(['--target', 'box'])).toThrow(/unknown pair option/);
    expect(() => parsePairArgv(['one', 'two'])).toThrow(/at most one instance id/);
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
