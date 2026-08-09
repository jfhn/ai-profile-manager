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
  capabilities: TargetCapability[]; // 'exec' | 'pty' | 'signal' | 'endpoint' | 'profiles'
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
- `close()` releases remote connections; open handles belong to their owner

Remote targets are persisted in `<dataDir>/targets.json`. Version 1 contains a
`targets` array whose entries have `id`, `label`, `transport: "ssh"`, `address`
and an explicit `approved` boolean. Invalid files fail daemon startup; omitted
files mean no remote targets. Unapproved entries are registered so selection
gets `target-not-approved`, but the registry never hands out their transport.

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
- `onError` is a live transport failure; it is remembered and reported by the
  exit that follows, because "the connection died" is more useful than the exit
  code a dead connection synthesizes.
- Launch T3 through `openPty` with argv and a `profileId`, not `exec`: a managed
  instance has to be stoppable, and `signal`/`onExit` on the pty handle are the
  only lifecycle the contract offers. The bound profile's credentials stay on
  the target — the pty's output is never read, because `t3 serve` prints a
  one-time pairing token into it.
- A remote instance binds exactly one profile: a `CommandSpec` carries one
  `profileId`, and a second provider's env could only come from moving
  credentials.
- `endpoint`, `pty`, `signal` and `profiles` are all required. A target missing
  any of them cannot host managed T3 instances and is filtered out of the
  picker (`GET /api/targets` exposes the capability list for exactly this).
- Nothing outlives the daemon on a remote target: the pty and the endpoint die
  with the transport, so `adopt()` reports remote instances as stopped instead
  of re-adopting them.
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
- `tailscale.test.ts` drives the SSH transport's endpoint through a scripted
  exec channel: serve argv, MagicDNS and serve-status parsing, port allocation,
  health, revocation on close, the missing-Tailscale message and the refusal to
  hand out a funnelled port. The SSH spawn underneath it stays untested, like
  the rest of `ssh.ts` — the two-device live check covers that.

`packages/daemon/src/t3/manager.remote.test.ts` drives the whole managed-T3
lifecycle on a target through the fake remote transport; the local behaviour it
must not disturb stays in `manager.test.ts`.

New transports should be added to the `IMPLEMENTATIONS` list in
`contract.test.ts`; if a transport cannot satisfy the suite, it should not
declare the capability.
