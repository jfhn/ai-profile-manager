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
| GET    | `/api/overview`                  | Providers + profiles + latest usage + sessions + T3 instances   |
| GET    | `/api/events`                    | SSE stream (`ServerEvent` types)                                |
| GET    | `/api/profiles`                  | List profiles                                                   |
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
| GET    | `/api/targets/:id/profiles`      | Profiles as that target reports them (`TargetProfilesResponse`) |
| GET    | `/api/t3`                        | List managed T3 instances (`T3ListResponse`)                    |
| POST   | `/api/t3`                        | Create instance (`CreateT3InstanceRequest`)                     |
| POST   | `/api/t3/:id/start`              | Start instance                                                  |
| POST   | `/api/t3/:id/stop`               | Stop instance                                                   |
| DELETE | `/api/t3/:id`                    | Remove instance (must be stopped)                               |

The target endpoints are read-only: approving a machine happens on the machine
running apm, never over the API. Neither payload carries anything secret — an
`ExecutionTarget` is identity plus capabilities, a `TargetProfileSummary` has
no home and no credentials.

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
