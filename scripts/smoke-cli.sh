#!/bin/sh
# End-to-end check of the *installed* apm command.
#
# Installs the launcher into a throwaway bin dir, then drives it from a
# directory outside the repository: start, status, url (and a real request with
# that URL), reuse, stop.
#
# It never touches a real daemon or real state: everything runs against its own
# APM_DATA_DIR under $TMPDIR and its own free port, and the daemon it starts is
# stopped again even when a check fails.
#
#   sh scripts/smoke-cli.sh [--launcher-only]
set -eu

REPO_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
INSTALL_ARGS=''

say() { printf 'smoke: %s\n' "$1"; }
die() {
  printf 'smoke: FAILED: %s\n' "$1" >&2
  exit 1
}

for arg in "$@"; do
  case $arg in
    --launcher-only) INSTALL_ARGS='--launcher-only' ;;
    -h | --help)
      printf 'usage: sh scripts/smoke-cli.sh [--launcher-only]\n\n'
      printf '  --launcher-only   assume the checkout is already built\n'
      exit 0
      ;;
    *) die "unknown option: $arg" ;;
  esac
done

command -v node >/dev/null 2>&1 || die 'node is not on your PATH'

# --------------------------------------------------------------- sandbox setup

WORK=$(mktemp -d "${TMPDIR:-/tmp}/apm-smoke.XXXXXX")
BIN=$WORK/bin
OUTSIDE=$WORK/cwd
APM=$BIN/apm
RUN_FILE=$WORK/data/run/daemon.json
mkdir -p "$BIN" "$OUTSIDE" "$WORK/data"

# Own data dir and own port: a daemon started here is invisible to the user's.
APM_DATA_DIR=$WORK/data
APM_PORT=${APM_SMOKE_PORT:-$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>console.log(p))})')}
export APM_DATA_DIR APM_PORT
case $APM_PORT in
  '' | *[!0-9]*) die "could not pick a free port (got \"$APM_PORT\")" ;;
  4747) die 'refusing to run on the default port 4747' ;;
esac

cleanup() {
  status=$?
  trap - EXIT
  if [ -x "$APM" ]; then "$APM" stop >/dev/null 2>&1 || true; fi
  # Last resort if the launcher itself is broken: kill the pid in the run file.
  if [ -f "$RUN_FILE" ]; then
    pid=$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$RUN_FILE" 2>/dev/null || true)
    if [ -n "${pid:-}" ]; then kill "$pid" 2>/dev/null || true; fi
  fi
  rm -rf "$WORK"
  [ "$status" -eq 0 ] || printf 'smoke: cleaned up after failure (exit %s)\n' "$status" >&2
  exit "$status"
}
trap cleanup EXIT INT TERM HUP

expect() { # expect <needle> <output> <what>
  case $2 in
    *"$1"*) ;;
    *) die "$3: expected \"$1\" in:
$2" ;;
  esac
}

say "sandbox $WORK, port $APM_PORT"

# ------------------------------------------------------------------- the check

say 'installing the launcher'
# shellcheck disable=SC2086
sh "$REPO_DIR/scripts/install-cli.sh" --bin-dir "$BIN" $INSTALL_ARGS >"$WORK/install.log" 2>&1 ||
  die "install-cli.sh failed:
$(cat "$WORK/install.log")"
[ -x "$APM" ] || die "$APM was not installed as an executable"

cd "$OUTSIDE" # everything below runs outside the repository

out=$("$APM" status)
expect 'not running' "$out" 'status before start'

out=$("$APM" --no-open)
expect "apm daemon started" "$out" 'start'
expect "http://127.0.0.1:$APM_PORT/?token=" "$out" 'start prints the url'
say 'start ok'

out=$("$APM" status)
expect 'running' "$out" 'status'
case $out in
  *token=*) die 'status leaked the auth token' ;;
esac
say 'status ok'

url=$("$APM" url)
lines=$(printf '%s\n' "$url" | wc -l | tr -d '[:space:]')
[ "$lines" -eq 1 ] || die "url printed $lines lines, expected just the url:
$url"
expect "http://127.0.0.1:$APM_PORT/?token=" "$url" 'url'
api="${url%%\?*}api/status?token=${url#*token=}"
node -e 'fetch(process.argv[1]).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))' "$api" ||
  die "the url from \`apm url\` is not usable: GET /api/status was rejected"
say 'url ok (authenticated request accepted)'

json=$("$APM" profiles --json)
lines=$(printf '%s\n' "$json" | wc -l | tr -d '[:space:]')
[ "$lines" -eq 1 ] || die "profiles --json printed $lines lines, expected one JSON document:
$json"
node -e '
  const value = JSON.parse(process.argv[1]);
  if (value.schemaVersion !== 1) process.exit(1);
  if (!value.defaultProfileIds || typeof value.defaultProfileIds !== "object") process.exit(1);
  if (!Array.isArray(value.profiles) || value.profiles.length !== 0) process.exit(1);
' "$json" || die 'profiles --json did not match the empty version 1 contract'
json=$("$APM" profiles --json --refresh)
node -e 'const value=JSON.parse(process.argv[1]);process.exit(value.schemaVersion===1?0:1)' "$json" ||
  die 'profiles --json --refresh did not return the version 1 contract'
say 'profiles contract ok'

out=$("$APM" --no-open)
expect 'already running' "$out" 'reuse'
say 'reuse ok'

out=$("$APM" stop)
expect 'stopped' "$out" 'stop'
out=$("$APM" status)
expect 'not running' "$out" 'status after stop'
say 'stop ok'

say 'all checks passed'
