# ai-profile-manager

## Goal

Build a local-first application for managing AI provider profiles, viewing
usage, and launching tools with the correct account.

## Product qualities

- Web app served by a local daemon; no desktop shell.
- Linux is the primary platform. Windows through WSL is secondary.
- A broken provider adapter must not take down the app.
- The dashboard should show profile identity, usage and freshness at a glance.
- One command starts or reuses the daemon and opens the dashboard.

## Core principles

- Credentials stay on the machine that owns them, with one deliberate
  exception: profiles enrolled in credential sync exchange their tokens with
  mutually approved machines over SSH, inside the two schema-validated sync
  messages and nowhere else (docs/TARGETS.md, "Credential sync").
- Profiles isolate accounts without overwriting global authentication files.
- Provider-specific behavior belongs in adapters.
- Discovery and usage collection are read-only by default.
- A process keeps the profile selected when it was launched.
- Stale data and failures are reported honestly.

## Architecture

```text
Web dashboard and terminal
  -> localhost daemon (HTTP, SSE and WebSocket)
      -> profile store
      -> usage scheduler and provider adapters
      -> PTY session host
      -> target registry
          -> local transport
          -> approved SSH transports
```

Profiles are plain data with an opaque id, provider, label, home, identity,
status, enabled flag and creation time. Usage snapshots are normalized into
provider-independent windows with percentages, reset times, source, freshness
and error state.

Provider CLIs run in PTYs with `CODEX_HOME`, `CLAUDE_CONFIG_DIR` or
`CURSOR_CONFIG_DIR` set from the chosen profile. Sessions outlive browser tabs.
The browser and `apm attach` are two clients of the same session host, with
bounded scrollback on reattach.

Execution targets extend the same session model to approved machines. Commands
cross the transport boundary as structured argv, cwd, environment and profile
ids. The target resolves profile credentials locally. Credentials never reach
the browser, logs or session payloads; they travel between machines only for
sync-enrolled profiles, inside the transport's two sync messages.

## Stack

- Node.js and TypeScript daemon using Fastify, `ws` and `node-pty`.
- Svelte and Vite frontend with xterm.js terminals and SSE updates.
- JSON for profile and target configuration.
- SQLite for usage snapshots.

## Security requirements

- Bind the API to localhost.
- Require a per-start token for API and WebSocket access.
- Validate browser origins.
- Never return or log provider credentials.
- Use owner-only permissions for state and caches.
- Require explicit approval before a remote target can run anything.
- Use structured argv and `shell: false` at process boundaries.

## Implemented product scope

- Claude, Codex and Cursor profile discovery, CRUD, defaults and onboarding.
- Profile-specific usage collection with cached and stale states.
- Local and target-scoped profile resolution.
- Persistent and connection-bound terminal sessions.
- Browser terminals plus `apm run`, `apm attach` and `apm sessions`.
- Approved SSH targets discovered from the local tailnet.
- Versioned JSON CLI contracts for profiles and targets.

## Next work

- Improve provider coverage while keeping adapter failures isolated.
- Add usage history views after the current snapshot flow is stable.
- Measure daemon idle cost and only consider a runtime rewrite if it matters.
- Add target transports only when they preserve the structured command and
  target-local credential boundaries.

## Acceptance criteria

- Multiple Claude and Codex profiles coexist without changing global files.
- The UI identifies each profile and provider.
- Usage includes reset times and freshness state.
- One failed profile does not stop other profiles from refreshing.
- Local and approved remote launches use the selected profile predictably.
- Sessions can detach, reattach, report their target and be terminated.
- No credentials appear in browser responses, logs or committed files.
