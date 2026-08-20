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
  capabilities: Array<'exec' | 'pty' | 'signal' | 'profiles' | 'sync'>;
  approved: boolean;
  status: 'online' | 'offline' | 'unknown';
}
```

Consumers must check a capability before offering work that requires it.
Missing capabilities fail with `TransportError('unsupported')`.

## Transport contract

`TargetTransport` provides:

| Method                   | Purpose                                                   |
| ------------------------ | --------------------------------------------------------- |
| `probe()`                | Report reachability without throwing                      |
| `exec(spec, opts)`       | Run argv to completion; non-zero exit is still a result   |
| `openPty(spec)`          | Open an interactive process with data, resize and signals |
| `profiles()`             | List safe profile summaries from that target              |
| `syncPull(sync)`         | Fetch a synced profile's credential bundle                |
| `syncPush(sync, bundle)` | Offer a rotated bundle; applied only when strictly newer  |
| `close()`                | Release the connection and its live PTYs                  |

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
`cwd-not-found`, `command-not-found`, `spawn-failed`, `timeout`,
`sync-conflict` and `sync-not-enabled`. API routes map them through
`packages/daemon/src/targets/errors.ts`.

## Profiles and credentials

Credentials cross the transport boundary in exactly one shape: the
`CredentialBundle` inside the two sync messages, between machines that
approved each other, over SSH. They never appear in session payloads, HTTP
responses, events or logs. Everything else below is unchanged.

`profiles()` returns only id, provider, label, status and enabled state. A
command names profile ids. The selected target resolves those ids and injects
its own `CLAUDE_CONFIG_DIR`, `CODEX_HOME` or `CURSOR_CONFIG_DIR` values
locally, with `AGENT_CLI_CREDENTIAL_STORE=file` for Cursor. Cursor’s
`XDG_CONFIG_HOME` (Linux) or `APPDATA` (Windows) reaches `cursor-agent`
alone: the target sets it directly when that is the command, and otherwise
puts a generated `cursor-agent` shim first on the session’s `PATH`.

Profile resolution is target-scoped. A profile id from one machine has no
meaning on another. `GET /api/targets/:id/profiles` and
`apm targets --profiles <id>` expose the safe summaries needed for selection.

## Credential sync

A Claude or Codex profile can share its OAuth credentials across machines.
Naive home-copying breaks: both providers rotate the refresh token, and both
the daemon and the provider CLIs rotate on their own, so two machines holding
independent copies log each other out. Sync makes one profile the **owner**
(the only daemon that background-refreshes) and the others **replicas**, tied
together by a sync id (`Profile.sync = { id, role }`). Cursor cannot sync —
its rotated tokens live only in process memory — and is excluded by
construction: its adapter has no `credentialSync`.

Mechanics (`packages/daemon/src/targets/sync.ts` and
`packages/collectors/src/credential-sync.ts`):

- The credential file's mtime is the rotation clock. Applying a bundle sets
  the file mtime to the bundle's `rotatedAt`, so re-offering known state is a
  no-op and machines cannot echo rotations back and forth.
- Push-on-rotate: every daemon polls its synced profiles' credential file
  mtimes (~15 s, including once at startup as catch-up) and pushes changed
  bundles to all approved remote targets. Receivers apply strictly-newer
  bundles only. Pushes to offline peers are dropped; the next rotation or
  restart retries.
- Pull-on-auth-failure: when usage collection reports an auth failure for a
  synced profile — owner or replica — the daemon pulls candidate bundles from
  its peers, applies the newest payload it has not already tried, and forces
  a usage refresh to validate it. This path recovers from missed pushes,
  clock skew and wrong last-writer picks.
- The remote agent answers `sync-pull`/`sync-push` from a read-only store
  view and only ever writes the profile's credential file through the
  provider adapter. Store mutations happen solely in each machine's own
  daemon. Two machines both claiming the owner role answer `sync-conflict`.

Setup requires apm on both machines and mutual approval in each machine's
`targets.json` (each side pushes to the other). Enable on the owner, adopt on
the replica:

```sh
owner$    apm profile sync-enable work
replica$  apm profile add claude --from-target owner-box work
```

The adopt flow resolves the remote profile, runs `apm profile sync-enable` on
the target through its own daemon, pulls the first bundle into a fresh
managed home and creates the local replica profile.

Security note: this legalizes no new reach. An approved SSH peer could
already read credential files through the exec channel; sync replaces that
ad-hoc possibility with a schema-validated, size-capped message pair. SSH
`authorized_keys` remains the authentication boundary. Worst case of the
remaining write race (a provider CLI rotates in the same instant a bundle is
applied): the profile reports an auth failure and the owner logs in again —
the same worst case a naive copy had on every rotation.

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
