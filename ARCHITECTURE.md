# Architecture

`apm` is one local daemon, one command-line client, and one browser UI. The
daemon owns profile state and is the only process that writes it.

## Components

- `packages/shared` defines provider, profile, session, target, and HTTP types.
- `packages/collectors` reads provider credentials, identity, and quota usage.
- `packages/daemon` stores profiles, collects usage, runs sessions, updates
  provider CLIs, and serves the HTTP, event, terminal, and static-web endpoints.
- `packages/web` is the Svelte dashboard served by the daemon.

## Data flow

The CLI and browser call the authenticated loopback API. Profile mutations and
usage changes pass through daemon services. The daemon emits server-sent events
so open dashboards can refetch current state. Terminal data uses WebSockets.
Remote commands cross only approved target transports.

Profiles contain provider config homes, not CLI installations. Sessions add the
selected config-home variable to a process and resolve the provider CLI from
the machine's `PATH`. Tool updates therefore run once per machine through the
provider executable's built-in updater.

Start reading at `packages/shared/src/api.ts`, then
`packages/daemon/src/server.ts`, and finally `packages/web/src/App.svelte`.
