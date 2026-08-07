# ai-profile-manager (apm)

Local-first companion app for managing AI provider profiles (Claude, Codex),
viewing quota usage, and launching tools with the correct account. See
[PLAN.md](PLAN.md) for goals and architecture, [docs/API.md](docs/API.md) for
the daemon API.

> **Status: early.** Built for my own setup and so far only exercised against
> my accounts (one Claude, one Codex). Linux/WSL is the primary platform.
> Usage collection reads local provider data and, for Claude, an undocumented
> OAuth usage endpoint — treat that as a maintenance risk, not a contract.
> Issues and reports welcome.

## Quick start

```sh
pnpm install
pnpm build
node packages/daemon/dist/main.js        # starts the daemon, prints URL, opens the browser
```

To get a global `apm` command, drop a wrapper into a directory on your PATH
(tsc rebuilds strip the execute bit, so a wrapper beats a symlink):

```sh
printf '#!/bin/sh\nexec node %s "$@"\n' "$PWD/packages/daemon/dist/main.js" \
  > ~/.local/bin/apm && chmod +x ~/.local/bin/apm
```

Development (daemon on :4747, Vite dev server with HMR on :5173):

```sh
pnpm dev
```

## Layout

- `packages/shared` — schemas and HTTP/WS API types, implementation-independent
- `packages/collectors` — provider adapters (usage collection, identity, env)
- `packages/daemon` — Fastify daemon: profiles, usage scheduler, PTY sessions, managed T3 instances; `apm` CLI
- `packages/web` — Svelte dashboard served by the daemon

## CLI

```sh
apm                       # start (or reuse) the daemon and open the dashboard
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
