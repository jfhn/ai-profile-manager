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

| Method | Path                             | Description                                                                  |
| ------ | -------------------------------- | ---------------------------------------------------------------------------- |
| GET    | `/api/status`                    | Daemon version, pid, data dir                                                |
| GET    | `/api/overview`                  | Providers + profiles + defaults + usage + sessions                           |
| GET    | `/api/events`                    | SSE stream (`ServerEvent` types)                                             |
| GET    | `/api/profiles`                  | List profiles                                                                |
| GET    | `/api/defaults`                  | Current provider defaults (`DefaultsResponse`)                               |
| PUT    | `/api/defaults/:provider`        | Set/recompute a default (`{profileId: string \| null}`)                      |
| POST   | `/api/profiles`                  | Adopt an existing home as a profile (`CreateProfileRequest`)                 |
| PATCH  | `/api/profiles/:id`              | Rename / enable / disable                                                    |
| DELETE | `/api/profiles/:id?purge=`       | Remove profile; `purge=true` also deletes managed homes                      |
| POST   | `/api/profiles/:id/sync-enable`  | Idempotently make a profile a credential-sync owner                          |
| POST   | `/api/profiles/:id/copy`         | Enroll on selected targets (`ProfileCopyRequest`)                            |
| POST   | `/api/profiles/:id/refresh`      | Refresh usage for one profile now                                            |
| POST   | `/api/usage/refresh`             | Refresh all enabled profiles now                                             |
| GET    | `/api/usage`                     | Latest snapshot per profile                                                  |
| GET    | `/api/tools`                     | Installed provider CLI versions and executable paths                         |
| POST   | `/api/tools/:provider/update`    | Run one provider CLI's built-in updater on this machine                      |
| GET    | `/api/discovery`                 | Unadopted provider homes (incl. global `~/.claude`, `~/.codex`, `~/.cursor`) |
| POST   | `/api/wizard`                    | Start prepare-login flow (`StartWizardRequest`)                              |
| GET    | `/api/wizard/:profileId`         | Wizard state: login command, credentials found, identity                     |
| POST   | `/api/wizard/:profileId/confirm` | Name + activate the pending profile                                          |
| GET    | `/api/sessions`                  | List terminal sessions (`SessionsResponse`)                                  |
| POST   | `/api/sessions`                  | Spawn a persistent or connection-bound PTY (`CreateSessionRequest`)          |
| POST   | `/api/sessions/:id/resize`       | Resize (`{cols, rows}`)                                                      |
| DELETE | `/api/sessions/:id`              | Kill (running) or dispose (exited)                                           |
| GET    | `/api/recent-dirs`               | Recent working directories for the cwd picker                                |
| GET    | `/api/targets`                   | Execution targets + capabilities (`TargetsResponse`)                         |
| GET    | `/api/targets/candidates`        | Tailnet machines, display-only (`TargetCandidatesResponse`)                  |
| POST   | `/api/targets`                   | Approve one machine as a target (`AddTargetRequest`)                         |
| DELETE | `/api/targets/:id`               | Revoke a target; closes its connection                                       |
| GET    | `/api/targets/:id/profiles`      | Profiles as that target reports them (`TargetProfilesResponse`)              |
| POST   | `/api/targets/:id/sync-adopt`    | Adopt a target profile as a local synced replica                             |
| POST   | `/api/sync/enroll`               | Internal target-agent enrollment into this daemon                            |

The wizard endpoints back both the dashboard modal and the headless CLI flow
(`apm profile add <provider>` — see the README); the CLI adds no endpoints of
its own.

`POST /api/profiles/:id/copy` requires a non-empty, unique list of approved
remote target ids. It enables sync on the source, reads one bounded provider
credential bundle, and enrolls exactly those targets. Its response contains
the updated source profile plus per-target success summaries or stable error
codes; it never contains the bundle. Partial success is deliberate. The
loopback-only-in-purpose `/api/sync/enroll` is called by the SSH target agent
with the target daemon's bearer token so that daemon remains the sole writer
of its profile store. It is protected by the same loopback binding and token
checks as every other API route.

Tool updates are machine-scoped. The daemon accepts only a provider id and maps
it to a fixed executable and `update` argument. It does not accept shell text,
package names, URLs, versions, or elevation. Only one update runs at a time.

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

`CreateSessionRequest.lifecycle` is optional and defaults to `persistent`,
which preserves the existing detach/reattach behavior. `connection-bound` is
an opt-in for process-owning integrations: after at least one terminal
WebSocket has attached, closing the last attached client sends `SIGHUP` to the
session exactly once. It does not make a never-attached session self-destruct;
clients should delete a session if their initial attach fails.

## Terminal WebSocket

`GET /ws/terminal/:sessionId?token=<token>` upgrades to a WebSocket. The
Origin header, when present, must be a localhost origin. Frames are JSON text
messages typed in `packages/shared/src/sessions.ts`:

- server → client: `scrollback` (bounded replay, sent first), `data`, `exit`, `error`
- client → server: `input`, `resize`

Multiple clients may attach to one session; input is merged, output fanned
out. Closing the socket detaches without killing the PTY.

## SSE events

`usage-updated` (with snapshot), `profiles-changed`, and `sessions-changed`
(with session list). Clients refetch `/api/overview` on `profiles-changed`.

## Provider defaults

`GET /api/overview` lists providers as `ProviderInfo`: `id`, `label`,
`capabilities`, and `defaultApp` (argv[0] for a normal session: `claude`,
`codex`, `cursor-agent`).

`defaultProfileIds` is a partial map keyed by `claude`, `codex`, and `cursor`.
The daemon keeps exactly one default per provider while that provider has at
least one active, enabled profile; a missing key means no such profile exists.
When the selected profile is disabled or deleted (or the key is cleared with `null`),
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
