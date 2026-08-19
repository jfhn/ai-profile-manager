# Cursor provider

Add Cursor as a third provider, same shape as Claude and Codex: isolated
homes, wizard / `apm profile add`, usage on the dashboard, env-bound
`apm run`. Product target for usage is the two monthly Spending bars
(**Cursor Models** and **Other Models**), not IDE `--user-data-dir`
isolation and not Cursor-as-a-consumer of Claude/Codex profiles.

## Decisions

| Topic                        | Choice                                                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product                      | Full Claude/Codex clone, as far as Cursor actually allows                                                                                         |
| Usage windows                | Monthly `cursor_models` and `other_models` only                                                                                                   |
| Integrations                 | Breaking OK — bump `apm profiles --json` (and target-scoped profiles) to schemaVersion 2 with `cursor` in the enum                                |
| Homes                        | `CURSOR_CONFIG_DIR` + `AGENT_CLI_CREDENTIAL_STORE=file` + `XDG_CONFIG_HOME` (Linux) / `APPDATA` (Windows) so `auth.json` lands in the home        |
| Default home                 | `~/.cursor`                                                                                                                                       |
| IDE fallback                 | Only for that external default home, if `auth.json` is missing: read the IDE session token from `state.vscdb`. Never a profile home, never purged |
| Login / default app          | `cursor-agent login` / `cursor-agent`. `agent` is the same provider app                                                                           |
| API-key profiles             | No (`CURSOR_API_KEY` writes nothing into the home)                                                                                                |
| Electron / `--user-data-dir` | Out of scope                                                                                                                                      |

Givens: usage comes from Cursor’s undocumented dashboard API (same
maintenance-risk posture as Claude OAuth). On-demand spend and the “$400
included” copy stay in adapter `notes`, not windows. `UsageWindow` stays
percent + `resetAt`.

Expired access tokens: refresh **in memory only**, never write `auth.json`
or `state.vscdb`. Same per-home in-flight guard as Codex. If refresh is
impossible or still 401, `failureKind: 'auth'` — not a prompt that
pretends every expiry needs `cursor-agent login`.

## Non-goals

- Launching the Cursor IDE from a PTY
- Treating `~/.config/Cursor` as a home
- Dollar used/limit fields on `UsageWindow`
- A third on-demand window
- Silently extending schemaVersion 1

## Adapter

New `packages/collectors/src/adapters/cursor.ts`, registered next to
claude/codex. `Record<ProviderId, ProviderAdapter>` stays exhaustive.

```ts
provider: 'cursor'
displayName: 'Cursor'
capabilities: {
  usage: true
  usageSources: ['local-files', 'oauth-api']  // local = auth.json / IDE sqlite; network = dashboard API
  identity: true
  windows: ['cursor_models', 'other_models']
  notes: undocumented dashboard API; file credential store; default-home IDE token fallback
}
env(home): {
  CURSOR_CONFIG_DIR: home
  AGENT_CLI_CREDENTIAL_STORE: 'file'
  XDG_CONFIG_HOME: home   // Linux: file store writes $XDG_CONFIG_HOME/cursor/auth.json
  // APPDATA: home        // Windows
}
loginArgv(): ['cursor-agent', 'login']
loginCommand(home): env assignments + `cursor-agent login`
defaultHome(): ~/.cursor
```

`hasCredentials` / `detectIdentity` are local-files only. They look at
`auth.json` under `home`, or `home/cursor/auth.json` (Linux file store when
`XDG_CONFIG_HOME` is the home). If that file is missing **and** `home` is the
adapter’s `defaultHome()`, they may read the IDE token from `state.vscdb`
(see below). Compare with `fs.realpathSync` (missing-path fallback to
`path.resolve`) so a symlinked `~/.cursor` still matches the stored
external home. Managed homes never take that path.

Identity from the same place as the credentials. A home with CLI
`auth.json` uses JWT `email` if present, otherwise `cli-config.json`
`authInfo.email` / `teamName` from that login. Do not use JWT `sub`
(`auth0|user_…`) as the dashboard account. The default home without
`auth.json` uses the IDE `cachedEmail`, not `~/.cursor/cli-config.json`
(that file can be a different CLI account). No network in
`detectIdentity`. Plan label can wait for a usage fetch (`planType` on
the snapshot, `identity.plan` when the adapter can see it locally).

## Token resolution

Order, first hit wins:

1. `auth.json` in the profile home, or `cursor/auth.json` / `Cursor/auth.json`
   under it (CLI file store). Parse conservatively:
   accept a bearer/JWT string from known keys (`accessToken`, `token`,
   nested auth objects). Never log the value.
2. Default home only: Linux
   `~/.config/Cursor/User/globalStorage/state.vscdb`, macOS
   `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`,
   Windows `%APPDATA%/Cursor/User/globalStorage/state.vscdb`. Open
   **read-only** via `node:sqlite` `DatabaseSync`. Read `ItemTable` key
   `cursorAuth/accessToken`. Lock/busy/missing DB → no credentials or a
   collect error, never a thrown adapter failure.
3. Nothing → `hasCredentials` false; collectUsage returns an auth failure.

`adapter.env()` cannot delete inherited keys, and both local spawn and
`apm profile add` merge `{ ...process.env, ...profileEnv }`. A daemon-level
`CURSOR_API_KEY` would bypass the home. After applying a Cursor profile
env (login and session), **delete** `CURSOR_API_KEY` from the child env.
Empty string is not enough. Profile binding is the home.

## Usage collection

Mirror Codex’s cache/cooldown shape (`cursor-usage.json` in the profile
cache dir, ~5 min TTL, 5 min error cooldown, `force` skips both).
`allowNetwork: false` serves a usable cache or fails honestly — do not
invent percentages from local session logs.

Network, pinned (assert in tests: URL, method, headers, body):

```
POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage
Content-Type: application/json
Connect-Protocol-Version: 1
Authorization: Bearer <token>
body: {}
```

Timeout like the other adapters. 401 → in-memory refresh if a refresh
token exists, else auth failure. Do not call `/auth/full_stripe_profile`.
`GetPlanInfo` only if the usage payload has no plan name **and** we have
a token-safe fixture for it; otherwise `planType` stays null.

Fetch failures must not stringify the request. `error` is a status-only
generic string (`safeReason` does not catch `access_token`, cookie
values, or a bare JWT).

Map two windows, both `resetAt` = `billingCycleEnd`:

| Window id       | Label         | Percent source                                                                                                                        |
| --------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `cursor_models` | Cursor Models | Prefer a payload field clearly named for that pool; else `planUsage.autoPercentUsed` (today’s dashboard “Cursor Models” / Auto meter) |
| `other_models`  | Other Models  | Prefer an explicit Other Models field; else `planUsage.apiPercentUsed`                                                                |

If neither pair of fields exists, return an error snapshot, not a guess.
Clamp percents to 0..100. `remainingPercent` = 100 − used when used is
known. Pool percents are often fractional; the dashboard shows at most
two decimal places. `planType` from membership/plan name (e.g. `ultra`).
Source string names the endpoint, not “IDE UI”.

Runway: add both ids to `WINDOW_DURATION_MS` / labels / order as monthly
(existing 30-day `monthly` length). Burn pace is approximate; do not
extend `UsageWindow` with billing-cycle start.

## Schema and CLI

`PROVIDER_IDS = ['claude', 'codex', 'cursor']`.

- `defaultProfileIdsSchema`: optional `cursor` key (`.strict()` otherwise
  unchanged). On-disk profiles.json v2 still loads; no store version bump.
- `ProfilesCliResponse.schemaVersion`: **2**. Same for
  `targetProfilesCliResponseSchema` (it embeds `provider`). Leave
  `targets --json` at 1 (no provider enum).
- `docs/INTEGRATIONS.md`: v2 closed enum is `claude` \| `codex` \|
  `cursor`; consumers must reject other values and other schema versions.
- `apm profile add <claude\|codex\|cursor>`.
- `APP_PROVIDERS` (shared, used by `apm run` and the session host):
  `cursor-agent` maps to `cursor`. A mismatched profile refuses to spawn.
  The bare name `agent` stays unclaimed — it is too generic to pin to a
  provider.

## UI

Web must keep `import type` from `@apm/shared` (zod stays out of the
bundle). Do **not** import `PROVIDER_IDS` in the web package.

Drive wizard options and session profile grouping from `app.providers`
(already on overview) instead of hardcoded `['claude','codex']`.

`ProviderInfo` today is `{ id, label, capabilities }`. The session modal
uses the provider id as argv (`claude` / `codex`), which would spawn
`cursor` (the Electron app). Add `defaultApp: string` to `ProviderInfo`,
sourced from `adapter.loginArgv()[0]` (`claude`, `codex`,
`cursor-agent`). Session choices are those apps plus `custom`. `agent`
remains a known app for provider `cursor` so a typed `agent` still
matches.

Visual tokens: `--cursor` in `app.css`, Badge tone, ProfileCard,
ProviderMark. Mark must not collide with Codex’s `C` — use something
else (e.g. `▸`). Fake-daemon `loginCommand` must include the Cursor form.

## Tests (no live Cursor account)

`packages/collectors/src/adapters/cursor.test.ts`:

- `auth.json` (or `cursor/auth.json`) present → credentials, env, login argv
- missing those files on a non-default home → no credentials, no sqlite
- default home + fixture `state.vscdb` → credentials and identity; collect
  uses that token
- default home via symlink → fallback still runs; a non-default home that
  happens to be a symlink to `~/.cursor` is **not** enough (realpath of
  the profile home vs realpath of `defaultHome()`)
- default home sqlite busy/missing → auth error, adapter does not throw
- inherited `CURSOR_API_KEY` is absent from the child env
- usage request is the pinned Connect RPC (not a cookie-only variant)
- in-memory refresh on 401; auth.json / sqlite unchanged
- usage fixture with `autoPercentUsed` / `apiPercentUsed` → two windows,
  monthly reset, planType
- usage fixture with explicit pool fields if we discover them → those win
- payload without either pair → error snapshot
- 401 → `failureKind: 'auth'`
- cooldown / force / `allowNetwork: false` behave like Codex
- adversarial redaction: `access_token=…`, `Authorization: Bearer …`,
  cookie values, and a bare JWT never appear in `error` strings

Daemon/CLI/web: add Cursor to the existing hardcoded two-provider tests
that would otherwise go stale (parse, profile-add, fake-daemon, runway
grouping, wizard). Prefer iterating `PROVIDER_IDS` in daemon tests.

## Docs

README, PLAN.md implemented scope, `docs/API.md` discovery line,
`docs/INTEGRATIONS.md` v2, `docs/TARGETS.md` env mention
(`CURSOR_CONFIG_DIR` next to the existing two). Headless onboarding:
`apm profile add cursor`; extra args after `--` go to `cursor-agent login`.
Note that `AGENT_CLI_CREDENTIAL_STORE=file` writes an owner-only
unencrypted `auth.json`. `CURSOR_CONFIG_DIR` alone is not enough: on Linux the
CLI writes `$XDG_CONFIG_HOME/cursor/auth.json`, so apm also sets
`XDG_CONFIG_HOME` to the profile home. IDE fallback
is default-home only.

## Files (expected)

- `packages/shared/src/provider.ts`, `profile.ts` comment, `schemas.ts`, `api.ts`
- `packages/collectors/src/index.ts`, `adapter.ts` comment, `adapters/cursor.ts`, `adapters/cursor.test.ts`
- `packages/daemon/src/cli/parse.ts`, `commands.ts`, tests; `sessions/host.ts`; `core/profiles.ts` comments if any
- `packages/web`: WizardModal, NewSessionModal, Badge, ProviderBadge, ProviderMark, ProfileCard, app.css, stores labels, fake-daemon, runway labels/order, tests
- `docs/*`, `README.md`, `PLAN.md`

## Acceptance

- `apm profile add cursor` creates a managed home, runs
  `cursor-agent login` with the env above, activates when `auth.json`
  appears.
- `apm run <label> cursor-agent` (and `agent`) injects that env; other
  provider apps still refuse a Cursor profile.
- Dashboard shows Cursor profiles with two monthly windows matching the
  Spending bars when the API payload is the current shape.
- Adopting `~/.cursor` without `auth.json` still works if the IDE token
  is present; purge never touches the IDE user-data tree.
- `apm profiles --json` is schemaVersion 2 and may include `"cursor"`.
- One failed Cursor collect does not block Claude/Codex refreshes.
- No token in API responses, logs, or committed fixtures.
