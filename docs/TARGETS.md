# Execution targets and transports

apm can run work on more than the machine it is installed on. Everything that
spawns a process, drives a terminal or exposes an HTTP service goes through two
pieces:

- an **execution target** — a machine, with a stable id, an identity, an
  approval flag and a capability list (`packages/shared/src/target.ts`)
- a **transport** — the seam that actually runs things on that target
  (`packages/shared/src/transport.ts`)

The machine the daemon runs on is always present as the target `local`, and an
omitted target selection always means `local`. Nothing about existing local
behavior changes when no target is named.

Concrete transports (Tailscale, SSH, anything else) are implementations behind
this contract, never part of the model. `ExecutionTarget.transport` is a label
for diagnostics — no consumer branches on it.

## The model

```ts
interface ExecutionTarget {
  id: TargetId; // stable across restarts; 'local' for this machine
  label: string;
  kind: 'local' | 'remote';
  transport: string; // implementation id, diagnostics only
  identity: { hostname; address; fingerprint }; // never anything secret
  capabilities: TargetCapability[]; // 'exec' | 'pty' | 'signal' | 'endpoint' | 'profiles' | 'detached'
  approved: boolean; // remote targets run nothing until a human approved them
  status: 'online' | 'offline' | 'unknown';
}
```

Capabilities are not a formality: a transport may implement a subset, and using
a missing one fails with `TransportError('unsupported')`. Check
`transport.supports(capability)` (or `hasCapability(target, …)`) before offering
a feature in the UI or CLI.

## The contract

`TargetTransport` (all methods reject with `TransportError`):

| Method              | Purpose                                               |
| ------------------- | ----------------------------------------------------- |
| `probe()`           | Reachability; reports `'offline'` instead of throwing |
| `exec(spec, opts)`  | Run argv to completion; a non-zero exit is a result   |
| `openPty(spec)`     | Interactive process: data, resize, signal, exit       |
| `openEndpoint(req)` | Forward/publish a service port, with health           |
| `profiles()`        | Profiles as the target sees them                      |
| `close()`           | Release connection-level resources                    |

A command is always structured data:

```ts
interface CommandSpec {
  argv: readonly string[]; // argv[0] is the executable; never a command line
  env?: Record<string, string>;
  cwd?: string;
  profileId?: string; // the *target* injects that profile's provider env
}
```

There is no API anywhere that takes a shell string. The local transport spawns
with `shell: false`; a remote transport must pass argv as argv. Target selection
is likewise an id (`targetIdSchema`), never a hostname that could be
interpolated somewhere.

`PtyHandle` gives `write`, `resize`, `signal` (`SIGHUP`/`SIGINT`/`SIGTERM`/
`SIGKILL`), `onData`, `onExit` and `close`. Listener registration returns its
own unsubscribe function, `onExit` fires exactly once and replays its status to
late listeners, and everything is inert after exit.

`EndpointHandle` wraps one service port on the target:

- `endpoint.scope` is `'loopback'` (service is on this machine), `'forwarded'`
  (transport forwards a local port) or `'published'` (transport exposes the
  target's own address)
- `endpoint.url` is `null` until the service actually answers, then it is a URL
  a browser on _this_ machine can open
- `health()` probes once, `waitUntilHealthy(timeoutMs)` polls, `onClose` fires
  when the transport tears the endpoint down
- `close()` stops forwarding/publishing — it never stops the service itself

Failures are `TransportError` with a `code` from `TRANSPORT_ERROR_CODES`
(`target-not-found`, `target-not-approved`, `unsupported`, `unreachable`,
`unauthorized`, `closed`, `profile-not-found`, `cwd-not-found`,
`command-not-found`, `spawn-failed`, `timeout`, `endpoint-failed`).
`packages/daemon/src/targets/errors.ts` maps each one onto the HTTP status and
error code the API already uses — route handlers should use `toApiFailure`
rather than inventing their own mapping.

## Credentials and profiles

Provider credentials never leave the machine that owns them. There is no
credential proxy and no credential sync:

- `transport.profiles()` returns `TargetProfileSummary` — id, provider, label,
  status, enabled. Deliberately no `home` and nothing secret.
- To run something with a profile you send its **id** in `CommandSpec.profileId`
  and the target resolves the provider env (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`)
  locally.
- Profile resolution is therefore always target-scoped:
  `registry.profiles(targetId)` feeds `resolveProfile()`
  (`packages/daemon/src/cli/parse.ts`), which works on local profiles and remote
  summaries alike. A profile id or label from one target means nothing on
  another.

## Registry

`createTargetRegistry(localTransport, remotes)`
(`packages/daemon/src/targets/registry.ts`) maps ids to transports and is
exposed as `AppContext.targets`:

- `transportFor(undefined | null | 'local')` → the local transport
- unknown id → `target-not-found`; unapproved remote → `target-not-approved`
- the local target cannot be replaced
- `addRemote(transport)` / `removeRemote(id)` are the mutation seam: a target
  approved while the daemon runs is selectable immediately, and a revoked one
  is dropped and its transport closed — which revokes the endpoints that
  transport published and ends the ptys it opened, so nothing is left running
  on a machine whose approval was just withdrawn, and work still in flight
  fails with that transport's own `closed` error instead of reaching it
- `close()` releases remote connections; open handles belong to their owner

## Adding and removing targets

The dashboard's **Targets** page is the normal way in. It has two lists: the
machines already registered, and the machines on your tailnet
(`GET /api/targets/candidates`). Discovery is display-only — seeing a machine
there grants nothing. **Add** on one row opens a small dialog for that one
machine, and confirming it is the approval: `POST /api/targets` writes the
entry with `approved: true`, registers it and makes it selectable at once.
**Revoke** does the reverse through `DELETE /api/targets/:id`.

Nothing is ever approved implicitly, there is no bulk approve, and there is no
free-form host field anywhere: the address always comes from a machine the
tailnet reported, and the API rejects one that does not
(`not-a-tailnet-machine`, 400). Editing `targets.json` by hand stays the
deliberate escape hatch for an address the tailnet does not know. Only the
tailnet is ever consulted — apm never scans hosts or probes ports.

Discovery itself is one structured argv call on **this** machine,
`tailscale status --json` (`packages/daemon/src/targets/discovery.ts`), with
the same 15s budget the rest of the tailscale code uses. Peers become
candidates with their hostname, MagicDNS name (trailing dot stripped), online
state, OS and the id of the target already using them, if any; this machine is
never among them. Without tailscale — not installed, not running, not logged in
— the call fails with `tailscale-unavailable` and the page says so, which is
deliberately not the same as an empty tailnet.

`<dataDir>/targets.json` remains the store, and it is still the file, not the
API, that decides what exists at startup. Version 1 contains a `targets` array
whose entries have `id`, `label`, `transport: "ssh"`, `address` and an explicit
`approved` boolean:

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

Editing it by hand keeps working exactly as before, and the API writes the same
shape: every mutation validates the whole file against the schema it is read
with and replaces it by rename, so a crash mid-write cannot leave a
half-approved set behind. Invalid files fail daemon startup, and a request that
would have to read a broken file fails with `target-config-invalid` rather than
treating it as "no targets". Omitted files mean no remote targets. Unapproved
entries are registered so selection gets `target-not-approved`, but the
registry never hands out their transport. `local` is reserved and duplicate ids
are rejected — over the API as `target-exists` (409), in the file as a startup
failure.

The SSH transport starts the fixed `apm __target-agent` command in batch mode.
All dynamic profile, argv, cwd, env, input, resize and signal values cross that
connection as JSON fields. They never become part of the SSH command. SSH
authentication and host verification stay with the user's normal SSH setup.

Its `endpoint` capability is Tailscale Serve, run on the target through that
same exec channel (`packages/daemon/src/targets/tailscale.ts`): the service
stays on the target's loopback address and `tailscale serve --bg --https=<port>
http://127.0.0.1:<service>` publishes it as HTTPS on the machine's own MagicDNS
name, which is what makes the endpoint `'published'` and reachable from another
device. `close()` runs the same invocation with `off`, so closing an endpoint is
also the revocation path. Funnel is never enabled, and a port that comes back
funnelled is withdrawn instead of handed out. The capability is declared
unconditionally because capabilities are static; a target without Tailscale
fails `openEndpoint` with `endpoint-failed` naming the prerequisite.

Its `detached` capability is three agent verbs (`detached-spawn`,
`detached-inspect`, `detached-stop`) backed by the local transport on the
target: the process runs in its own session, scoped to an immediate child of
the target's managed T3 directory, with a state file (`apm-service.json`)
recording instance id, pid, port and the pid's kernel start time. Inspect and
stop go by that record and verify the start time first, so a recycled pid is
never mistaken for the service. An agent too old for the verbs makes them fail
with `unsupported`, naming the fix — the daemon degrades to a clear error, it
does not crash.

## What consumers may assume

### `apm run --target <target>` (issue #18)

- `targets.transportFor(id)` for selection, with `undefined` meaning local, so
  the existing local `apm run` path is unchanged.
- `exec` for one-shot commands and `openPty` for interactive ones; both require
  the `exec`/`pty` capability.
- Terminal plumbing: `write`, `resize` on window changes, `signal('SIGINT')` for
  Ctrl-C, `onExit` for the process' exit status.
- Profile names must be resolved through `targets.profiles(targetId)` before
  launching; never assume the local profile list applies.
- User input reaches the transport as argv entries only. Do not build a command
  line, and do not put the target address anywhere near one.
- Map failures with `toApiFailure` so the CLI prints the same errors the API
  returns.
- A client WebSocket only attaches to a daemon-owned session. Disconnecting it
  does not close the target PTY, and a later `apm attach` replays scrollback and
  resumes live I/O. A target transport failure emits a terminal error and a
  recorded exit, so no process is silently left untracked.

### Managed T3 on a target (issue #19)

Implemented in `packages/daemon/src/t3/manager.ts`; the user-facing side is
[T3-REMOTE.md](T3-REMOTE.md).

- `openEndpoint({ port: null, healthPath })` for the instance's port. The target
  allocates it, which makes port allocation per-target by construction, and the
  manager names that port on T3's own command line afterwards.
- `endpoint.url` is the dashboard link and `waitUntilHealthy` is the start-up
  wait. Never build `http://127.0.0.1:<port>` by hand — a remote instance is
  reached through a forward or the target's own address, and only the endpoint
  knows which. A remote instance whose endpoint reports scope `'loopback'` is
  rejected outright; `'forwarded'` is accepted but flagged in the UI as
  reachable from the daemon's machine only.
- `onClose` means the endpoint is gone (forward dropped, connection lost); the
  instance is shown as unhealthy, not silently linked.
- Launch T3 through `spawnDetached` with argv and the bound profiles' ids, not
  `exec` and not `openPty`: a managed instance must survive the daemon and
  still be stoppable, and the detached trio (`spawnDetached` /
  `inspectDetached` / `stopDetached`) is the only lifecycle the contract
  offers for that. The bound profiles' credentials stay on the target — and
  the process's output is discarded over there, because `t3 serve` prints a
  one-time pairing token into it.
- `endpoint`, `detached` and `profiles` are all required. A target missing
  any of them cannot host managed T3 instances and is filtered out of the
  picker (`GET /api/targets` exposes the capability list for exactly this).
- Managed T3 instances are the one thing that outlives the daemon on a remote
  target, and only under their target-side record. Everything else is enforced
  rather than assumed: the agent kills its own process group on hangup, stdin
  EOF and exit, so a dropped connection leaves no pty child behind; a start
  first stops whatever the instance's record still names, then steps over
  service ports an existing serve entry already proxies to; `shutdown()` only
  lets go of the handles (the process and its serve entry keep serving); and
  `adopt()` re-links a still-verified process — or reports the instance
  stopped with the reason, never relaunching it.
- Existing local instances keep their loopback URL: they still use the detached
  spawn + HTTP probe path (`packages/daemon/src/targets/net.ts`), because only a
  detached process survives a daemon restart, and their endpoint is recorded
  with scope `'loopback'`.

## Tests

`packages/daemon/src/targets/`:

- `contract.test.ts` runs one suite against **both** the local transport and the
  deterministic fake remote one (`test-support/fake-remote.ts`) — argv safety,
  exit handling, pty streaming/lifecycle and the endpoint health lifecycle.
- `local.test.ts` covers what only a real machine shows: profile env injection,
  cwd defaults, stdin, timeouts, real signals, port allocation.
- `registry.test.ts` covers target selection, approval, target-scoped profile
  resolution, unreachable/closed connections and the error mapping.
- `routes.test.ts` covers the read-only `/api/targets` endpoints.
- `discovery.test.ts` drives tailnet discovery through a scripted exec channel:
  peer parsing, hub exclusion, matching candidates against the registry, the
  suggested target id, and the three ways tailscale can fail to answer.
- `admin.test.ts` covers the seam between the file and the running daemon —
  approving persists _and_ registers without a restart, revoking removes the
  entry _and_ closes the transport, and reserved/duplicate/option-shaped
  requests are refused without writing anything.
- `tailscale.test.ts` drives the SSH transport's endpoint through a scripted
  exec channel: serve argv, MagicDNS and serve-status parsing, port allocation
  around live and stale entries, health, revocation on close, the
  missing-Tailscale message and the refusal to hand out a funnelled port. The
  SSH spawn underneath it stays untested, like the rest of `ssh.ts` — the
  two-device live check covers that.
- `agent.test.ts` runs a real agent process and kills it the way sshd does, to
  prove nothing it spawned is left behind. Its pty child ignores `SIGHUP` on
  purpose: a child that dies on hangup passes with no teardown at all, because
  the kernel hangs the terminal up by itself, so it would prove nothing.

`packages/daemon/src/t3/manager.remote.test.ts` drives the whole managed-T3
lifecycle on a target through the fake remote transport; the local behaviour it
must not disturb stays in `manager.test.ts`.

New transports should be added to the `IMPLEMENTATIONS` list in
`contract.test.ts`; if a transport cannot satisfy the suite, it should not
declare the capability.
