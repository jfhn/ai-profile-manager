# Execution targets and transports

apm can launch commands and terminal sessions on its own machine or on an
approved remote machine. The shared model has two parts:

- An execution target identifies a machine, its approval state and capabilities.
- A transport runs structured commands on that target.

The daemon's machine is always the `local` target. Omitting a target id means
`local`, so existing local commands do not need a target option.

## Model

```ts
interface ExecutionTarget {
  id: TargetId;
  label: string;
  kind: 'local' | 'remote';
  transport: string;
  identity: { hostname: string | null; address: string | null; fingerprint: string | null };
  capabilities: Array<'exec' | 'pty' | 'signal' | 'profiles'>;
  approved: boolean;
  status: 'online' | 'offline' | 'unknown';
}
```

Consumers must check a capability before offering work that requires it.
Missing capabilities fail with `TransportError('unsupported')`.

## Transport contract

`TargetTransport` provides:

| Method             | Purpose                                                   |
| ------------------ | --------------------------------------------------------- |
| `probe()`          | Report reachability without throwing                      |
| `exec(spec, opts)` | Run argv to completion; non-zero exit is still a result   |
| `openPty(spec)`    | Open an interactive process with data, resize and signals |
| `profiles()`       | List safe profile summaries from that target              |
| `close()`          | Release the connection and its live PTYs                  |

Commands are structured values:

```ts
interface CommandSpec {
  argv: readonly string[];
  env?: Readonly<Record<string, string>>;
  cwd?: string;
  profileIds?: readonly string[];
}
```

There is no transport API that accepts a shell command string. The local
transport spawns with `shell: false`. The SSH transport sends dynamic argv,
cwd, environment, profile ids and terminal messages as JSON fields to the fixed
`apm __target-agent` command.

`PtyHandle` supports input, resize, signals, data listeners, error listeners,
exit listeners and close. Exit fires once and is replayed to late listeners.
Closing a target connection closes its live PTYs.

Transport errors use shared codes: `target-not-found`, `target-not-approved`,
`unsupported`, `unreachable`, `unauthorized`, `closed`, `profile-not-found`,
`cwd-not-found`, `command-not-found`, `spawn-failed` and `timeout`. API routes
map them through `packages/daemon/src/targets/errors.ts`.

## Profiles and credentials

Credentials never cross the transport boundary.

`profiles()` returns only id, provider, label, status and enabled state. A
command names profile ids. The selected target resolves those ids and injects
its own `CLAUDE_CONFIG_DIR`, `CODEX_HOME` or `CURSOR_CONFIG_DIR` values
locally, with `AGENT_CLI_CREDENTIAL_STORE=file` and `XDG_CONFIG_HOME` (Linux)
or `APPDATA` (Windows) for Cursor.

Profile resolution is target-scoped. A profile id from one machine has no
meaning on another. `GET /api/targets/:id/profiles` and
`apm targets --profiles <id>` expose the safe summaries needed for selection.

## Registry and approval

The target registry maps configured ids to transports. Unknown ids fail with
`target-not-found`. Unapproved targets stay visible but fail with
`target-not-approved`. The local target cannot be replaced or revoked.

The dashboard's Targets page discovers machines with `tailscale status --json`.
Discovery grants no authority. Adding one candidate writes an approved entry to
`<dataDir>/targets.json` and registers it immediately. Revoking it removes the
entry and closes the transport.

The address in an API approval request must match a currently discovered
tailnet machine. Editing `targets.json` remains the explicit escape hatch for a
host discovery does not know.

Version 1 of the file is:

```json
{
  "version": 1,
  "targets": [
    {
      "id": "dev-box",
      "label": "Dev box",
      "transport": "ssh",
      "address": "dev-box.tailnet.ts.net",
      "approved": true
    }
  ]
}
```

Writes validate and atomically replace the whole file. Invalid files fail
startup or mutation with `target-config-invalid`. A missing file means there
are no remote targets.

## Remote sessions

`apm run --target <id>` resolves the profile against that target, then creates
the same daemon-owned session used locally. The web terminal and CLI attach to
that session. Disconnecting a client normally detaches without killing it.

`--ephemeral` selects the connection-bound lifecycle. After the first client
attaches, losing the last client sends `SIGHUP` once. Ordinary sessions remain
persistent and attachable.

The target agent kills its PTY process group when its SSH channel closes. This
keeps dropped transports from leaving untracked processes behind. Session list
and event payloads retain the authoritative target id for local and remote
sessions.

## Tests

The target contract suite runs against the real local transport and a
deterministic fake remote transport. Other tests cover registry approval,
target-scoped profiles, discovery, persisted target configuration, structured
agent messages, process-group teardown and remote session flows.
