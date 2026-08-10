# External profile integration

Tools that own their own process or PTY lifecycle can ask `apm` for profile
metadata instead of embedding apm or using `apm run`:

```sh
apm profiles --json
apm profiles --json --refresh
```

The command starts or reuses the local daemon. `--refresh` forces a usage
collection attempt for every enabled, non-pending profile and waits for it
before reading the result. Without it, the latest persisted snapshots are
returned. Successful `--json` output writes one JSON document and a trailing
newline to stdout; daemon logs and failures never share stdout. A failure is
reported on stderr with a non-zero exit status.

## Version 1 stdout schema

```json
{
  "schemaVersion": 1,
  "defaultProfileIds": {
    "claude": "6ba4b56c-..."
  },
  "profiles": [
    {
      "id": "6ba4b56c-...",
      "provider": "claude",
      "label": "work",
      "home": "/home/me/.local/share/apm/homes/6ba4b56c-...",
      "status": "active",
      "enabled": true,
      "usage": null
    }
  ]
}
```

Consumers must reject an unsupported `schemaVersion`. The `profiles` array
includes pending, errored and disabled entries so a saved profile id can be
diagnosed precisely. `usage` is either the complete `UsageSnapshot` or `null`
when no snapshot exists. Credentials and detected account identity are not
part of this contract.

`defaultProfileIds` is intentionally partial. An absent provider key means the
user has no default for that provider; starting new provider work must stop
with an actionable prompt rather than selecting the first profile. A present
id always refers to an active, enabled profile of the matching provider.
Disabling or deleting it clears the default and does not silently choose a
replacement. Renaming a profile preserves its id and default selection.

The first eligible profile for a provider may become its initial default.
When a v1 `profiles.json` is upgraded to v2, apm infers a default only if that
provider has exactly one active, enabled profile. Ambiguous migrations leave
the provider unset.

## Launch ownership

The `home` path is the provider configuration root. A process-owning
integration binds Claude with `CLAUDE_CONFIG_DIR=<home>` and Codex with
`CODEX_HOME=<home>`, then persists the profile `id` with its own session so a
restore can resolve that exact entry. It should use the current default only
for genuinely new work. A missing saved id, provider mismatch, disabled
profile or non-active status is an error; never fall back to the current
default for a restore.

`apm run <profile> <app> ...` remains the interactive path when apm should own
the PTY and attach lifecycle. The metadata command does not change that
behavior, modify global `~/.claude` or `~/.codex`, or launch provider CLIs.
