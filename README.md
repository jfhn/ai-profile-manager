# ai-profile-manager (apm)

Local-first companion app for managing AI provider profiles (Claude, Codex,
Cursor), viewing quota usage, and launching tools with the correct account. See
[PLAN.md](PLAN.md) for goals and architecture, [docs/API.md](docs/API.md) for
the daemon API, and [docs/TARGETS.md](docs/TARGETS.md) for the execution-target
and transport contract.

> **Status: early.** Built for my own setup and so far only exercised against
> my accounts (one Claude, one Codex). Cursor is included as a third provider.
> Linux/WSL is the primary platform.
> Usage collection reads local provider data and, for Claude, an undocumented
> OAuth usage endpoint. Treat that as a maintenance risk, not a contract.
> Cursor usage is an undocumented dashboard RPC with the same posture.
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
apm profiles --json # stable profile/default/usage contract for integrations
apm tools            # installed provider CLIs and their exact paths
apm tools update codex # update one shared CLI with its own installer
apm targets --json  # stable execution-target contract for integrations
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
- `packages/daemon` — Fastify daemon: profiles, usage scheduler, PTY sessions; `apm` CLI
- `packages/web` — Svelte dashboard served by the daemon

## CLI

```sh
apm                       # start (or reuse) the daemon and open the dashboard
apm url                   # print the authenticated dashboard URL, open nothing
apm profile add claude    # log in to a fresh managed profile, no dashboard needed
apm profile add cursor    # same flow for Cursor
apm profile copy codex:work --to devbox --to laptop
                          # copy OAuth credentials to selected approved targets
apm profiles              # human-readable profiles and provider defaults
apm profiles --json       # versioned machine contract, JSON only on stdout
apm profiles --json --refresh
                          # refresh usage first, then print the contract
apm targets               # local plus configured remote execution targets
apm targets --json        # versioned machine contract for integrations
apm tools                 # Claude, Codex and Cursor CLI versions on this machine
apm tools update codex    # update the shared executable, not each profile
apm targets --profiles devbox --json
                          # target-scoped profiles, without local home paths
apm run work claude       # run claude bound to profile "work"
apm run work cursor       # Cursor; spawns cursor-agent, never the IDE
apm run work bash         # any command; provider CLIs inside it stay bound
apm run cursor:work bash  # provider-qualified label when "work" is ambiguous
apm run --target devbox --cwd /srv/repo work claude --resume
                          # run in an explicit directory on approved target "devbox"
apm run --target devbox --cwd /srv/repo --ephemeral work claude
                          # close the target process when this client disconnects
apm attach claude-work-1  # reattach; detach with Ctrl-] or Ctrl-5
apm sessions | status | stop
```

Provider CLI installations are machine-wide. Profiles isolate credentials and
configuration, but they resolve the same executable from `PATH`. The tools
command calls that executable's built-in updater, so npm, native installer and
Homebrew installs keep using their own update path.

### Sessions for arbitrary commands

`apm run <profile> bash` (or any other command) opens a terminal where every
provider CLI you start inside it is bound to that profile. That is the point
of the feature: you work normally in a shell, an editor, or a script, and a
nested `claude`, `codex`, or `cursor-agent` call uses the profile's account
instead of whatever the machine defaults to. Agents and tools that shell out
to a provider CLI inherit the binding the same way.

For Claude and Codex the binding is one provider-named variable in the
session env. Cursor needs `XDG_CONFIG_HOME`, which would rebind git, gh, and
every other tool in the session — so the session env stays clean and a
generated `cursor-agent` shim earlier on `PATH` applies that variable to the
one binary that needs it. Windows gets no shim; there, only `apm run <profile>
cursor` binds Cursor.

When a label exists for several providers, prefix the provider:
`apm run cursor:work bash`.

### Headless profile onboarding

`apm profile add <claude|codex|cursor>` runs the whole add-profile flow in the
terminal. On an SSH-only machine no dashboard is required. It starts (or
reuses) the daemon without opening a browser, creates a fresh managed home,
runs the provider's own login command in your terminal bound to that home
(`CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `CURSOR_CONFIG_DIR`, plus
`AGENT_CLI_CREDENTIAL_STORE=file` and `XDG_CONFIG_HOME` for Cursor), waits for credentials to appear,
and activates the profile with `--label <label>` or a label suggested from the
detected account.

```sh
apm profile add claude --label work
apm profile add cursor
apm profile add codex -- --device-auth   # extra args go to the provider login
```

Provider authentication stays with the provider CLI, including its own
browser or device requirements — apm never creates provider accounts. The
explicit cross-machine copy command described below is separate from login:

- **Claude Code** always needs a browser _somewhere_: over SSH the login
  prints a URL you open on any device, and a code to paste back into the
  terminal. Exit the `claude` REPL after logging in to continue.
- **Codex** can log in without a local browser via `-- --device-auth`
  (must be enabled in ChatGPT security/workspace settings) or fully
  non-interactively via `-- --with-api-key` (pipe the key on stdin). Note
  that API-key logins carry no account identity, so pass `--label`.
- **Cursor** login is `cursor-agent login`. `CURSOR_CONFIG_DIR` isolates
  `cli-config.json`; the file store writes `$XDG_CONFIG_HOME/cursor/auth.json`,
  so apm sets `XDG_CONFIG_HOME` to the profile home for `cursor-agent` itself
  — a session running anything else keeps its own config roots. That `auth.json`
  is owner-only and unencrypted (Cursor's own tradeoff). There
  are no `CURSOR_API_KEY` profiles. An API key writes nothing into the home.
  Extra args after `--` go to `cursor-agent login`.
- Token/env-var auth (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`) writes
  no credential files into a profile home, so it cannot be onboarded as a
  profile.

Adopting `~/.cursor` without `auth.json` can still work if the IDE session
token is in `state.vscdb`. That fallback is default-home only. Purge never
touches `~/.config/Cursor`.

A failed or interrupted login keeps the pending profile: rerunning
`apm profile add <provider>` resumes it (`--new` forces a fresh home), and
the dashboard can remove it.

Remote targets are added on the dashboard's **Targets** page: it lists the
machines on your tailnet, and **Add** on the one you want approves that machine
and makes it usable straight away. Discovery shows machines; only you turn one
into a target.

The approved set is stored in `~/.local/share/apm/targets.json` (or under
`APM_DATA_DIR`), which stays hand-editable, and targets are selected only by
their configured id:

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

### Copying a profile to selected machines

Claude and Codex OAuth profiles can be copied from the machine that already
has the login to one or more approved targets in a single action:

```sh
apm profile copy claude:work --to devbox
apm profile copy codex:personal --to devbox --to laptop
```

`--to` is required and repeatable. Copying is opt-in; apm never enrolls every
known machine by default. The command sends only the provider adapter's
credential subset plus the profile provider and label. The target daemon puts
it in a fresh owner-only managed home and registers an active replica; it does
not receive chats, session history, caches, projects, or the rest of the
source profile directory. A duplicate label is suffixed on the target, and an
existing provider default is left unchanged (the copy becomes the default
only when the target has no eligible default for that provider).

No second provider login is needed. Existing batch-mode SSH authentication is
the only transport authentication step. The target must have this version of
apm installed and available on its SSH login `PATH`; apm starts its target
daemon if necessary. Cursor and file-less/API-key authentication are not
copyable by this flow. After enrollment, the existing credential sync keeps
Claude/Codex OAuth rotations moving between the linked profiles.

SSH uses batch mode and runs the fixed `apm __target-agent` entry point; set up
SSH authentication separately and make `apm` available on the remote login
PATH. Profiles can either already exist there or be enrolled with `apm profile
copy`; the provider tool itself must be installed there before the profile can
be used.
Setting `approved` to `false` keeps the declaration visible to the registry but
prevents it from running anything; revoking on the Targets page removes the
entry and closes the connection immediately. In an attached terminal, press
`Ctrl-]` or `Ctrl-5` to detach. Both the legacy control byte and the enhanced
CSI-u encoding used by modern TUIs are recognized. Enter followed by `~d`
remains a fallback when the keyboard layout emits a literal tilde; `~~` sends
one literal leading tilde. A dropped terminal connection also only detaches;
use `apm attach <session>` to reconnect while the remote process is still
running or to see its recorded exit.

State lives in `~/.local/share/apm` (override with `APM_DATA_DIR`, which is
resolved to an absolute path at startup): profiles in `profiles.json`, approved
remote declarations in `targets.json`, usage snapshots in SQLite, and managed
provider homes under `homes/`. Raw credentials stay inside provider homes; apm
never sends them to the browser or returns them from its API. They cross to an
approved target only for an explicit profile-copy or credential-sync action,
inside the bounded SSH agent protocol.

External tools can resolve per-provider defaults, exact profile homes and usage
without adopting apm's PTY lifecycle. The versioned CLI contract and its
missing-default semantics are documented in
[docs/INTEGRATIONS.md](docs/INTEGRATIONS.md).

## Credits

The usage collectors are a TypeScript port of my
[noctalia-ai-usage-monitor](https://github.com/jfhn/noctalia-ai-usage-monitor)
collector, updated with lessons from its successor (bounded session scans and
honest per-account attribution).

## License

[MIT](LICENSE)
