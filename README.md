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
apm run work claude       # run claude bound to profile "work"
apm run work bash         # any command; children inherit the profile env
apm attach claude-work-1  # reattach to a running session
apm sessions | status | stop
```

State lives in `~/.local/share/apm` (override with `APM_DATA_DIR`): profiles
in `profiles.json`, usage snapshots in SQLite, managed provider homes under
`homes/`. Raw credentials stay inside provider homes; apm never copies them,
never refreshes OAuth tokens, and never sends them to the browser.

## Credits

The usage collectors are a TypeScript port of my
[noctalia-ai-usage-monitor](https://github.com/jfhn/noctalia-ai-usage-monitor)
collector, updated with lessons from its successor (bounded session scans,
honest per-account attribution). The web UI's look is modeled on
[T3 Code](https://github.com/pingdotgg/t3code).

## License

[MIT](LICENSE)
