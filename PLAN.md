# ai-profile-manager

## Goal

Build a local-first companion application for managing AI provider profiles, viewing usage, and launching tools with the correct account. T3 Code should be a supported integration, not a hard dependency.

### Product qualities

- Web app served by a local daemon; no desktop shell.
- Linux is the primary platform; Windows/WSL is second class.
- Reliability over features: a broken provider adapter must never take down the app.
- Near-zero idle footprint: the daemon should idle at minimal RAM and ~0% CPU
  (long-term goal; consciously relaxed for the Node-based v1 — see Stack).
- Looks polished and is easy to use — the dashboard should give overview at a glance.
- Increases productivity: fewer steps to see quota state and launch the right account.
- Single-command start: one command starts (or reuses) the daemon, prints the URL,
  and opens the default browser. Everything else happens in the web UI.

## Core principles

- Local-first: credentials stay on the user's machine.
- Profile isolation: never switch accounts by overwriting global auth files.
- Provider-agnostic core: provider-specific behavior belongs in adapters.
- Read-only by default: account discovery and usage inspection must not mutate provider state.
- Session-bound identity: an account is selected when a process/thread starts; running sessions are not silently switched.
- Honest status: show stale data, unsupported fields, authentication errors, and data sources clearly.

## MVP

1. Define a profile model for Codex and Claude.
2. Discover/configure profiles using explicit provider config directories or homes.
3. Reuse the collectors from `jfhn/noctalia-ai-usage-monitor` and its more
   advanced successor repo, extracted as one shared package.
4. Normalize usage into provider-independent windows:
   - used and remaining percentage
   - reset time
   - plan/account label where available
   - source, last refresh, stale state, and error
5. Add a local API and web UI showing all profiles.
6. Allow selecting a profile and launching the provider CLI with its environment.
7. Persist profile metadata and cached usage, but not raw credentials.

## Architecture

```text
Web UI (dashboard + xterm.js terminals)
  -> local API / daemon (HTTP + WebSocket)
      -> profile store
      -> usage scheduler
      -> provider adapters
      -> PTY session host
      |   -> Codex / Claude / other provider CLIs
      |      (spawned with the profile's env: CODEX_HOME, CLAUDE_CONFIG_DIR, ...)
      -> service supervisor
          -> managed T3 instances (own port + base dir, profile env)
```

### Sessions: two kinds

The daemon launches two different kinds of children; conflating them would be
a design error:

- **Terminal sessions** — interactive TUIs (`claude`, `codex`) in a PTY,
  rendered in the browser via xterm.js.
- **Managed services** — server processes (T3 instances) with no PTY: spawned
  detached with the profile env, supervised by port + health check, logs to a
  bounded buffer/file. Their UI is their own web app, linked from the
  dashboard — never rendered through xterm.js.

### Terminal sessions

Provider CLIs run as PTY sessions owned by the daemon and are rendered in the
browser with xterm.js over a WebSocket (the same model as t3code, VS Code
terminals, and ttyd):

- A session is bound to exactly one profile at spawn time (env-based isolation);
  this is what "session-bound identity" means concretely.
- Sessions outlive the browser tab: closing the tab detaches, the session list
  shows running sessions, and reattaching replays a bounded scrollback buffer.
- The same sessions are reachable from a real terminal via `run`/`attach`
  subcommands, so the web UI and the shell are two views of one session host.
- Terminal WebSockets are an arbitrary-code-execution surface: require the
  per-start auth token and validate the Origin header, even on localhost.

### Profile

```text
Profile {
  id
  provider
  label
  configPath or homePath
  accountIdentity
  status (pending | active | error)
  enabled
  createdAt
}
```

### Usage snapshot

```text
UsageSnapshot {
  profileId
  windows[]
  fetchedAt
  source
  stale
  error
}
```

## Provider adapters

Start with:

- **Codex:** inspect the profile's session/rate-limit data and support an explicit Codex home. Investigate a direct live usage source later.
- **Claude:** support statusline/cache data first, then the existing local OAuth usage retrieval as an optional adapter path. Treat undocumented endpoints as maintenance risks.

Later candidates: Cursor, OpenCode, Gemini CLI, GitHub Copilot, and API-key providers.

Every adapter should declare capabilities rather than pretending all providers expose the same data.

## Isolation mechanisms

Both mechanisms are spawn-time and inherited by all children, so concurrent
sessions on different profiles work naturally; the unit of binding is the
process tree, not the machine.

- **Primary: environment-based.** Spawn with the profile's `CODEX_HOME` /
  `CLAUDE_CONFIG_DIR`. Simple, portable, sufficient for CLIs that honor the
  variables.
- **Fallback: mount-namespace-based (Linux).** Spawn under `bwrap`/`unshare -m`
  with the real config path (e.g. `~/.claude`) bind-mounted to the profile
  home. The tool sees the "normal" directory but reads the profile's data.
  Needed only for tools that ignore the env vars or hardcode paths.
- **Known limit:** one process tree = one profile per provider. Mixing two
  accounts of the same provider inside a single host app (e.g. one T3
  instance) is impossible from outside; see T3 integration.

## T3 Code integration

### Phase 1: independent usage companion

Read the same provider data as T3 and display profiles/usage without changing T3. This should work with unmodified T3 Code.

### Phase 2: profile-aware launching

Launch T3 or provider CLIs with the selected profile's environment/configuration. New sessions use the selected profile; existing sessions remain attached to their original profile.

This binds a whole T3 instance to one profile per provider. Per-session
account mixing inside one T3 instance requires one of:

1. **Shim binaries** — if T3 config allows a custom provider CLI path, point it
   at generated wrappers (`claude-<profile>` sets the profile env and execs the
   real CLI). Configuration only, no T3 modification; check this first.
2. Multiple T3 instances, one per profile.
3. The Phase 3 upstream change.

### Phase 3: optional deep integration

Add a T3 adapter or small upstreamable change that exposes the selected profile to provider startup. Avoid depending on undocumented internal WebSocket contracts as the primary integration mechanism.

## Stack (decided)

- **Daemon:** Node.js (current LTS) + TypeScript. Chosen for speed of iteration
  and collector reuse; the near-zero-footprint goal is relaxed for the first
  version. Keep the daemon lean (no heavy frameworks; `node:http`/Fastify, `ws`,
  `node-pty`) and rewrite-friendly: all schemas and the HTTP/WS API are defined
  independently of the implementation so a Go/Rust rewrite can slot in behind
  the same frontend if the footprint bothers us later.
- **Collectors:** imported as a library into the daemon (same runtime), shared
  with the existing usage-monitor repo as one package.
- **Frontend:** Svelte + Vite, built to static files served by the daemon.
  Client-side app is required anyway for xterm.js terminals; SSE for live tiles.
- **Storage:** JSON file for profiles (few, human-readable, hand-editable);
  SQLite via built-in `node:sqlite` for usage snapshots (append-heavy, easy
  retention/pruning, enables history graphs later without migration).

## Security requirements

- Bind the API to localhost by default.
- Require the per-start auth token on all API and WebSocket endpoints and
  validate the Origin header — terminal WebSockets are an
  arbitrary-code-execution surface even on localhost.
- Never send access tokens or credential contents to the browser.
- Do not log authorization headers, cookies, or credential paths unnecessarily.
- Use restrictive permissions for local state and caches.
- Make remote access an explicit opt-in with authentication and encrypted transport.
- Do not build a hosted credential proxy for subscription accounts.

## Implementation phases

### Phase 0 — foundation

- Set up the decided stack (Node + TypeScript daemon, Svelte frontend).
- Spike: verify profile isolation by creating two homes per provider
  (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`), logging into each, and running both
  CLIs simultaneously without cross-contamination.
- Add formatting, linting, tests, and basic project documentation.
- Define schemas for profiles, capabilities, usage windows, and errors.

### Phase 1 — collector library

- Extract reusable normalization and caching code from the POC.
- Make all paths profile-specific.
- Add Codex and Claude adapters with fixture-based tests.

### Phase 2 — local service and UI

- Add profile CRUD and discovery.
- Add the prepare-login flow ("add profile" wizard); the app itself never
  performs logins:
  1. Create a fresh profile home and register it as pending.
  2. Show the exact login command to run in a normal terminal, per provider:
     `CODEX_HOME=<home> codex login`; for Claude, `CLAUDE_CONFIG_DIR=<home>
claude` — a fresh home triggers the login flow on first start.
  3. Wait for the login: lightweight polling while the wizard is open and/or an
     explicit "I'm done" button. If no credentials are found on "I'm done",
     say so and keep waiting.
  4. Read the credentials, resolve the account identity, and show what was
     detected (account, plan) so the user confirms the right login landed.
  5. Ask for a profile name (prefilled from the detected identity), then save
     the profile to the central store.
  - Pending homes that are abandoned can be cleaned up from the UI.
- Add refresh/status endpoints.
- Build the profile list and usage dashboard.

### Phase 3 — terminal sessions

- Add the PTY session host: spawn, resize, detach/reattach, bounded scrollback.
- Add `apm run <profile> <app> [args...]` and `apm attach <session>` CLI
  behavior. apm flags precede the positionals; everything after `<app>` is
  passed to the app verbatim (`--` supported as an optional escape hatch).
  The app determines the provider, so profile names are scoped per provider —
  `work` can exist for both Claude and Codex. Both positionals are always
  required to keep parsing unambiguous.
- `<app>` accepts known provider apps and arbitrary commands alike. Known apps
  (`claude`, `codex`, later `t3`) let apm validate that the profile's provider
  matches; any other command is run as-is with the profile's env injected —
  e.g. `apm run work bash` opens a shell in which every subsequent `claude`
  call uses the work account.
- Add provider-specific environment construction.
- Every session has an explicit working directory: the CLI inherits the shell's
  cwd; the web UI offers a recent-directories picker.
- Render sessions in the web UI via xterm.js over WebSocket (token + Origin check).
- Sessions are for launching and working with already-authenticated profiles;
  logins stay terminal-side via the Phase 2 prepare-login flow.

### Phase 4 — T3 integration

- Multi-instance T3 is **validated** (2026-08-07): `t3 serve --port <p>
--base-dir <dir>` runs concurrently with another instance; separate base
  dirs are required because `~/.t3` (server-runtime.json, provider caches)
  assumes a single runtime. Launch recipe:
  `CLAUDE_CONFIG_DIR=<home> CODEX_HOME=<home> t3 serve --port <p> --base-dir <t3 home>`.
- Add managed T3 instances as a first-class feature: start/stop per profile
  from the dashboard, daemon-assigned ports, health checks, "Open" link into
  the instance's own UI, detached processes re-adopted after daemon restart.
- Budget note: each instance is a full Node server (~100–200 MB); instances
  are started on demand, never one-per-profile by default.
- Add a documented integration path.
- Decide whether a T3 adapter/fork is needed for in-app switching
  (shims first — see T3 integration Phase 2).

## MVP acceptance criteria

- Two Codex profiles and two Claude profiles can coexist without changing global credentials.
- The UI clearly identifies each profile and its provider.
- Usage data is shown with reset times and freshness state.
- A failed or expired profile does not prevent other profiles from refreshing.
- A selected profile launches the matching CLI account predictably.
- T3 continues working normally when used independently.
- No credentials appear in browser responses, logs, or committed files.

## Resolved decisions

- Delivery: localhost webapp, no desktop shell.
- Runtime: Node + TypeScript first; rewrite in Go/Rust later only if the
  footprint disappoints (see Stack section).
- Storage: JSON for profiles, SQLite for usage snapshots.
- Frontend: Svelte over HTMX — the xterm.js terminal and live tiles need a
  client-side app anyway; HTMX would only cover the CRUD dashboard half.
- Discovery: both — auto-discovered homes (including existing `~/.claude` and
  `~/.codex`) appear as suggestions the user explicitly confirms into profiles.
- Provider scope for v1: Codex and Claude only; Cursor/OpenCode later.
- T3 integration: none required for usefulness; Phase 1 works with unmodified T3.
- Token refresh: the daemon refreshes expired Claude OAuth tokens itself using
  the Claude Code CLI's own public client id, so an expired access token no
  longer blanks usage until the CLI happens to run. Write-back to
  `.credentials.json` is atomic (temp file + rename, mode 0600) and aborts when
  the on-disk tokens changed mid-refresh — a live CLI that refreshed first
  wins. A rejected refresh never modifies the file and surfaces as an
  auth-classified reason telling the user to re-login. Other providers' tokens
  are still never refreshed.
- Account selection is launch-scoped only: profiles apply to what apm starts
  (`apm run`, web terminal sessions, managed T3 instances). The global
  `~/.claude` / `~/.codex` are read-only to apm, keep working unchanged for
  normally launched apps, and are adopted as the initial default profiles.
  A global default-switch (e.g. shell hook) is a possible later opt-in feature,
  explicitly out of scope for now.
- Per-provider defaults are launch metadata, not a global switch. They identify
  the profile external process-owning integrations should use for new work;
  integrations restore existing work by its exact saved profile id.
