# ai-profile-manager (apm)

Local-first companion app for managing AI provider profiles (Claude, Codex),
viewing quota usage, and launching tools with the correct account. See
[PLAN.md](PLAN.md) for goals and architecture, [docs/API.md](docs/API.md) for
the daemon API, and [docs/TARGETS.md](docs/TARGETS.md) for the execution-target
and transport contract.

> **Status: early.** Built for my own setup and so far only exercised against
> my accounts (one Claude, one Codex). Linux/WSL is the primary platform.
> Usage collection reads local provider data and, for Claude, an undocumented
> OAuth usage endpoint — treat that as a maintenance risk, not a contract.
> Issues and reports welcome.

## Quick start

Needs Node >= 24 and pnpm 11 (pinned as `pnpm@11.3.0` via `packageManager`).
The checked-in `mise.toml` pins both, so [mise](https://mise.jdx.dev) users can
get them with `mise install`.

```sh
git clone https://github.com/jfhn/ai-profile-manager.git
cd ai-profile-manager
pnpm install:cli
```

That one command checks the prerequisites, installs dependencies, builds every
package (including the web UI) and puts an `apm` launcher in `~/.local/bin` —
pass `--bin-dir DIR` (or set `APM_BIN_DIR`) for somewhere else; it tells you if
that directory is not on your PATH. The launcher is a wrapper script that execs
`node` on this checkout, so rebuilds never break it and you never have to
reference `dist/` yourself. From any directory:

```sh
apm          # start (or reuse) the daemon, print its URL, open the dashboard
apm url      # print the authenticated URL, open nothing
apm status
apm stop
```

Re-run `pnpm install:cli` after a `git pull` to update — it is idempotent.
`pnpm uninstall:cli` removes the launcher again and leaves your data in
`~/.local/share/apm` alone. With mise: `mise run install` / `mise run uninstall`.

> **pnpm from Corepack?** It has to be a recent Corepack: 0.24.0 — the version
> Debian/Ubuntu ship as `node-corepack` — cannot launch pnpm 11 at all and fails
> with `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING` on every Node version. Either
> `npm i -g corepack@latest`, or install pnpm directly (`npm i -g pnpm@11.3.0`,
> or let mise provide it) and keep the distro shim off your PATH.

Development (daemon on :4747, Vite dev server with HMR on :5173):

```sh
pnpm dev
```

`pnpm smoke` drives the installed command end to end — it installs a launcher
into a temporary directory and exercises start/status/url/stop against its own
data dir and port, so a daemon you are already running stays untouched.

## Layout

- `packages/shared` — schemas and HTTP/WS API types, implementation-independent
- `packages/collectors` — provider adapters (usage collection, identity, env)
- `packages/daemon` — Fastify daemon: profiles, usage scheduler, PTY sessions, managed T3 instances; `apm` CLI
- `packages/web` — Svelte dashboard served by the daemon

## CLI

```sh
apm                       # start (or reuse) the daemon and open the dashboard
apm url                   # print the authenticated dashboard URL, open nothing
apm profile add claude    # log in to a fresh managed profile, no dashboard needed
apm run work claude       # run claude bound to profile "work"
apm run work bash         # any command; children inherit the profile env
apm run --target devbox work claude --resume
                          # run on the approved target "devbox"
apm attach claude-work-1  # reattach to a running session
apm sessions | status | stop
```

### Headless profile onboarding

`apm profile add <claude|codex>` runs the whole add-profile flow in the
terminal — on an SSH-only machine no dashboard is required. It starts (or
reuses) the daemon without opening a browser, creates a fresh managed home,
runs the provider's own login command in your terminal bound to that home
(`CLAUDE_CONFIG_DIR` / `CODEX_HOME`), waits for credentials to appear, and
activates the profile with `--label <label>` or a label suggested from the
detected account.

```sh
apm profile add claude --label work
apm profile add codex -- --device-auth   # extra args go to the provider login
```

Provider authentication stays with the provider CLI, including its own
browser or device requirements — apm never creates provider accounts or
copies credentials:

- **Claude Code** always needs a browser _somewhere_: over SSH the login
  prints a URL you open on any device, and a code to paste back into the
  terminal. Exit the `claude` REPL after logging in to continue.
- **Codex** can log in without a local browser via `-- --device-auth`
  (must be enabled in ChatGPT security/workspace settings) or fully
  non-interactively via `-- --with-api-key` (pipe the key on stdin). Note
  that API-key logins carry no account identity, so pass `--label`.
- Token/env-var auth (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`) writes
  no credential files into a profile home, so it cannot be onboarded as a
  profile.

A failed or interrupted login keeps the pending profile: rerunning
`apm profile add <provider>` resumes it (`--new` forces a fresh home), and
the dashboard can remove it.

Remote targets are declared in `~/.local/share/apm/targets.json` (or under
`APM_DATA_DIR`) and are selected only by their configured id:

```json
{
  "version": 1,
  "targets": [
    {
      "id": "devbox",
      "label": "Development box",
      "transport": "ssh",
      "address": "devbox.example",
      "approved": true
    }
  ]
}
```

SSH uses batch mode and runs the fixed `apm __target-agent` entry point; set up
SSH authentication separately and make `apm` available on the remote login
PATH. The target machine must have the selected profile and tool configured.
Setting `approved` to `false` keeps the declaration visible to the registry but
prevents it from running anything. A dropped terminal connection only detaches;
use `apm attach <session>` to reconnect while the remote process is still
running or to see its recorded exit.

State lives in `~/.local/share/apm` (override with `APM_DATA_DIR`): profiles
in `profiles.json`, approved remote declarations in `targets.json`, usage
snapshots in SQLite, and managed provider homes under `homes/`. Raw credentials
stay inside provider homes; apm never copies them, never refreshes OAuth tokens,
and never sends them to the browser or another target.

## Credits

The usage collectors are a TypeScript port of my
[noctalia-ai-usage-monitor](https://github.com/jfhn/noctalia-ai-usage-monitor)
collector, updated with lessons from its successor (bounded session scans,
honest per-account attribution). The web UI's look is modeled on
[T3 Code](https://github.com/pingdotgg/t3code).

## License

[MIT](LICENSE)
