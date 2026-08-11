# apm HTTP/WS API

The daemon binds to `127.0.0.1` only. All `/api` endpoints require the
per-start bearer token (`Authorization: Bearer <token>`; SSE and WebSocket
clients may use `?token=<token>` instead). Browser requests must come from a
localhost origin; requests with a non-local `Origin` header are rejected with 403. Failures return `{"error": {"code", "message"}}`.

The token is minted per daemon start and written only to
`<dataDir>/run/daemon.json` (mode 0600). Credentials (OAuth tokens etc.) are
never included in any response.

Type definitions for every payload live in `packages/shared/src/api.ts`.

## REST

| Method | Path                             | Description                                                     |
| ------ | -------------------------------- | --------------------------------------------------------------- |
| GET    | `/api/status`                    | Daemon version, pid, data dir                                   |
| GET    | `/api/overview`                  | Providers + profiles + defaults + usage + sessions + T3         |
| GET    | `/api/events`                    | SSE stream (`ServerEvent` types)                                |
| GET    | `/api/profiles`                  | List profiles                                                   |
| GET    | `/api/defaults`                  | Current provider defaults (`DefaultsResponse`)                  |
| PUT    | `/api/defaults/:provider`        | Set/recompute a default (`{profileId: string \| null}`)         |
| POST   | `/api/profiles`                  | Adopt an existing home as a profile (`CreateProfileRequest`)    |
| PATCH  | `/api/profiles/:id`              | Rename / enable / disable                                       |
| DELETE | `/api/profiles/:id?purge=`       | Remove profile; `purge=true` also deletes managed homes         |
| POST   | `/api/profiles/:id/refresh`      | Refresh usage for one profile now                               |
| POST   | `/api/usage/refresh`             | Refresh all enabled profiles now                                |
| GET    | `/api/usage`                     | Latest snapshot per profile                                     |
| GET    | `/api/discovery`                 | Unadopted provider homes (incl. global `~/.claude`, `~/.codex`) |
| POST   | `/api/wizard`                    | Start prepare-login flow (`StartWizardRequest`)                 |
| GET    | `/api/wizard/:profileId`         | Wizard state: login command, credentials found, identity        |
| POST   | `/api/wizard/:profileId/confirm` | Name + activate the pending profile                             |
| GET    | `/api/sessions`                  | List terminal sessions (`SessionsResponse`)                     |
| POST   | `/api/sessions`                  | Spawn a PTY session (`CreateSessionRequest`)                    |
| POST   | `/api/sessions/:id/resize`       | Resize (`{cols, rows}`)                                         |
| DELETE | `/api/sessions/:id`              | Kill (running) or dispose (exited)                              |
| GET    | `/api/recent-dirs`               | Recent working directories for the cwd picker                   |
| GET    | `/api/targets`                   | Execution targets + capabilities (`TargetsResponse`)            |
| GET    | `/api/targets/candidates`        | Tailnet machines, display-only (`TargetCandidatesResponse`)     |
| POST   | `/api/targets`                   | Approve one machine as a target (`AddTargetRequest`)            |
| DELETE | `/api/targets/:id`               | Revoke a target; closes its connection                          |
| GET    | `/api/targets/:id/profiles`      | Profiles as that target reports them (`TargetProfilesResponse`) |
| GET    | `/api/t3`                        | List managed T3 instances (`T3ListResponse`)                    |
| POST   | `/api/t3`                        | Create instance (`CreateT3InstanceRequest`)                     |
| POST   | `/api/t3/:id/start`              | Start instance                                                  |
| POST   | `/api/t3/:id/stop`               | Stop instance                                                   |
| DELETE | `/api/t3/:id`                    | Remove instance (must be stopped)                               |

The wizard endpoints back both the dashboard modal and the headless CLI flow
(`apm profile add <provider>` — see the README); the CLI adds no endpoints of
its own.

Approval is the boundary in the target endpoints, and it is always explicit.
`GET /api/targets/candidates` lists the machines this machine's tailnet already
lets it see (`tailscale status --json`, run here) and grants nothing: a
candidate carries a hostname, a MagicDNS name, online state, OS and whether it
is already a target. A machine becomes an execution target only through
`POST /api/targets` naming that one machine, which writes it to
`<dataDir>/targets.json` with `approved: true` and registers it immediately —
no restart and no bulk approve. The address must belong to a machine the
tailnet just reported (`not-a-tailnet-machine`, 400, otherwise), so a request
cannot point apm at a host of its choosing. `DELETE /api/targets/:id` is the
same act in reverse: the entry leaves the file and the transport is closed, so
anything still in flight fails with `target-closed`. The local target cannot be
added or removed.

None of these payloads carries anything secret — an `ExecutionTarget` is
identity plus capabilities, a `TargetCandidate` is a name on the tailnet, and a
`TargetProfileSummary` has no home and no credentials. Beyond the shared
transport codes these endpoints use `tailscale-unavailable` (503, tailscale is
missing or not answering), `not-a-tailnet-machine` (400), `target-exists` (409)
and `target-config-invalid` (500, `targets.json` no longer parses).

`POST /api/t3` takes an optional `targetId`; omitting it means the local
machine, so an existing client is unaffected. A remote instance's `url` and
`endpoint` come from that target's transport — see
[TARGETS.md](TARGETS.md) and [T3-REMOTE.md](T3-REMOTE.md). Transport failures
use the shared codes (`target-not-found`, `target-not-approved`,
`target-unsupported`, `target-unreachable`, `endpoint-failed`, …).

## Terminal WebSocket

`GET /ws/terminal/:sessionId?token=<token>` upgrades to a WebSocket. The
Origin header, when present, must be a localhost origin. Frames are JSON text
messages typed in `packages/shared/src/sessions.ts`:

- server → client: `scrollback` (bounded replay, sent first), `data`, `exit`, `error`
- client → server: `input`, `resize`

Multiple clients may attach to one session; input is merged, output fanned
out. Closing the socket detaches without killing the PTY.

## SSE events

`usage-updated` (with snapshot), `profiles-changed`, `sessions-changed`
(with session list), `t3-changed` (with instance list). Clients refetch
`/api/overview` on `profiles-changed`.

## Provider defaults

`defaultProfileIds` is a partial map keyed by `claude` and `codex`. The daemon
keeps exactly one default per provider while that provider has at least one
active, enabled profile; a missing key means no such profile exists. When the
selected profile is disabled or deleted (or the key is cleared with `null`),
the daemon promotes the eligible profile with the alphabetically first label,
so clients never pick a default on the user's behalf.
`PUT /api/defaults/:provider` accepts an active, enabled profile of that same
provider, or `null` to recompute the default. These mutations emit
`profiles-changed`.

Profile ids use the same opaque public rule as the CLI contract: preserve the
exact string, require nonblank content after trimming, reject Unicode `Cc`
control characters, and limit the UTF-8 representation to 256 bytes. Other
Unicode, punctuation, slashes, and edge/interior whitespace are allowed and do
not give an id path or shell semantics. The rule applies to profile/default ids
and API request fields that reference profiles.
