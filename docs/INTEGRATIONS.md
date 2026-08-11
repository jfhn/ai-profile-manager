# External profile integration

Tools that own their own process or PTY lifecycle can ask `apm` for profile
metadata instead of embedding apm or using `apm run`:

```sh
apm profiles --json
apm profiles --json --refresh
apm targets --json
apm targets --profiles <target-id> --json
```

The command starts or reuses the local daemon. `--refresh` forces a usage
collection attempt for every enabled, non-pending profile and waits for it
before reading the result. Without it, the latest persisted snapshots are
returned. Successful `--json` output writes one JSON document and a trailing
newline to stdout; daemon logs and failures never share stdout. A failure is
reported on stderr with a non-zero exit status.

Target discovery follows the same stdout and schema-version rules. `apm
targets --json` returns the local target plus configured remotes, including
their capability, approval, and status fields. `apm targets --profiles
<target-id> --json` returns profile summaries from that target's own namespace:

```json
{
  "schemaVersion": 1,
  "targetId": "devbox",
  "profiles": [
    {
      "id": "codex-work",
      "provider": "codex",
      "label": "work",
      "status": "active",
      "enabled": true
    }
  ]
}
```

Target profile summaries never contain `home`: a local path is meaningless on
another machine. A process-owning integration launches the selected entry with
`apm run --target <target-id> --cwd <target-path> <profile-id> <app> ...`.
When its local connection is the intended lifetime owner, it may add
`--ephemeral`; after the first attach, loss of the last client then terminates
the APM session instead of leaving it available to `apm attach`.

Target capability names are open-ended within schema version 1. Consumers must
check the capabilities they require and ignore or preserve unknown strings;
an added capability must never make an otherwise usable target invalid.
`targetsCliProducerSchema` from `@apm/shared` is a producer-side assertion used
by APM itself, not a forward-compatible consumer validator.

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
when no valid snapshot exists. Historical SQLite rows are runtime-validated;
malformed JSON, incomplete snapshots, invalid timestamps/status values, and
profile-id mismatches are omitted without rewriting usage history. A later
valid row becomes visible normally. Credentials and detected account identity
are not part of this contract.

Profile ids are opaque and must be preserved exactly. In schema version 1 an
id must be nonblank after trimming, contain no Unicode control character
(General Category `Cc`), and occupy at most 256 bytes when UTF-8 encoded. Edge
or interior whitespace, punctuation, slashes, and Unicode are otherwise valid;
an id is never a path segment or shell token.

Version 1 has a closed provider enum and default-key set: only `claude` and
`codex` are valid. Consumers should reject other provider values or keys. Adding
a provider therefore requires a schema-version bump or explicit compatibility
handling rather than silently extending version 1.

`defaultProfileIds` is intentionally partial. An absent provider key means the
provider has no active, enabled profile at all; starting new provider work must
stop with an actionable prompt rather than selecting the first profile. A
present id always refers to an active, enabled profile of the matching
provider. The daemon owns the selection: while a provider has at least one
eligible profile it keeps exactly one default, and when the selected profile
is disabled or deleted it promotes the eligible profile with the
alphabetically first label. Consumers must not choose a replacement
themselves. Renaming a profile preserves its id and default selection.

The same rule seeds initial defaults: the first eligible profile (by label)
for a provider becomes its default, including when a v1 `profiles.json` is
upgraded to v2.

## Launch ownership

The `home` path is the provider configuration root. A process-owning
integration binds Claude with `CLAUDE_CONFIG_DIR=<home>` and Codex with
`CODEX_HOME=<home>`, then persists the profile `id` with its own session so a
restore can resolve that exact entry. It should use the current default only
for genuinely new work. A missing saved id, provider mismatch, disabled
profile or non-active status is an error; never fall back to the current
default for a restore.

Every emitted `home` is absolute. `APM_DATA_DIR` is resolved to an absolute
path at startup. When an older v1 or v2 profile store contains a relative home,
apm resolves it once using the daemon startup working directory (the semantics
older releases used), validates the complete store, and atomically persists
the absolute form. Absolute external homes are not canonicalized or rewritten,
and an otherwise invalid store is left untouched.

`apm run <profile> <app> ...` remains the interactive path when apm should own
the PTY and attach lifecycle. The metadata command does not change that
behavior, modify global `~/.claude` or `~/.codex`, or launch provider CLIs.
