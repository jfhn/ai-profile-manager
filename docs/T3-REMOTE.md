# Managed T3 instances on a remote target

A managed T3 instance normally runs on the machine that runs apm. It can also
run on any **approved execution target** (see [TARGETS.md](TARGETS.md)) — the
dashboard creates, starts, stops and monitors it from here, while the process,
the project files and the provider credentials all stay over there.

Everything crosses one seam: the target's transport. There is no SSH command
line, no Tailscale invocation and no credential copy anywhere in the T3 code
path.

## What runs where

|                      | local target                                 | remote target                                                      |
| -------------------- | -------------------------------------------- | ------------------------------------------------------------------ |
| process              | detached `t3 serve`, survives an apm restart | detached `t3 serve` **on the target**, survives it too             |
| base dir             | `<dataDir>/t3/<id>`                          | `~/.local/share/apm/t3/<id>` **on the target**                     |
| provider env         | injected here from the bound profiles        | injected **by the target** from its own profiles                   |
| Open link            | `http://127.0.0.1:<port>`                    | whatever the target's endpoint publishes                           |
| after an apm restart | re-adopted if still healthy                  | re-adopted if still healthy — stopped, with the reason, if it died |

A remote instance is spawned in its own session on the target and recorded in
a state file inside its base dir (`apm-service.json`: instance id, pid, port —
never a credential). It keeps serving while apm is down; on the way back up
`adopt()` re-reads that record, verifies the pid still is that process, and
re-links the instance with its published endpoint. One that died in the
meantime is reported as stopped with the reason — apm never relaunches it on
its own. Stop and delete terminate the recorded process even when a different
daemon (or agent) than the one that spawned it does the stopping; the target
verifies the pid's kernel start time first, so a recycled pid is never killed.

## Prerequisites on the target

1. The machine is registered as an execution target and **approved** here. The
   dashboard's **Targets** page lists the machines on your tailnet; **Add** on
   the one you want is the approval, and it takes effect immediately — no
   daemon restart, and no file to edit (the approved set is still stored in
   `<dataDir>/targets.json`, see [TARGETS.md](TARGETS.md)). Nothing is ever
   approved for you, and an unapproved target runs nothing
   (`target-not-approved`, HTTP 403).
2. Its transport reports the `endpoint`, `detached` and `profiles`
   capabilities. A target missing any of them is filtered out of the picker and
   refused by the API (`target-unsupported`, HTTP 400).
3. **T3 Code is installed on the target** and `t3` is on the PATH of the user
   the transport connects as. A missing binary is reported as `app-not-found`.
4. The target has its own **active provider profiles**. Profile ids are
   target-scoped: the pickers ask the target (`GET /api/targets/:id/profiles`)
   and never offer this machine's profiles for a remote instance.
5. `printenv` and `mkdir` exist on the target — apm resolves the target user's
   home and creates the instance-private base dir with them, as plain argv.
   The target is a Linux machine (or WSL): the detached lifecycle verifies
   processes through `/proc`, exactly like `apm pair` does. The target's `apm`
   must also be recent enough to know the detached verbs; an older agent fails
   a start or an adoption with a clear `target-unsupported` error naming the
   fix (update apm on the target) instead of hosting anything.
6. **Tailscale is installed and logged in on the target**, and the SSH user may
   run `tailscale serve` without a password. That usually means one of:

   ```sh
   # on the target, once
   sudo tailscale set --operator=$USER
   ```

   MagicDNS and HTTPS certificates must be enabled for the tailnet (admin
   console → DNS), because the published URL is the machine's `*.ts.net` name
   over HTTPS. Without Tailscale the instance fails to start with
   `endpoint-failed` naming the prerequisite; nothing hangs.

A remote instance binds **up to one profile per provider** — a Claude and a
Codex profile side by side, exactly like a local instance. A command carries
only the bound profiles' opaque ids and the target resolves each one to its
provider environment locally, so no credential ever moves between machines. A
provider left unbound falls back to the target machine's default home — never
to an apm default profile.

## Trusted network only

The endpoint must be reachable on a **private, authenticated network** — a
tailnet or an equivalent. Do not expose a managed instance to the public
internet, and do not put it behind Tailscale Funnel: a T3 instance is a shell
on the target with your provider account attached.

Publishing is the transport's job, not T3's. apm starts `t3 serve` with nothing
but `--port` and `--base-dir`, so it listens on the target's own loopback
address, and the transport's `openEndpoint` is what makes that port reachable.

The SSH transport does that with Tailscale Serve, run **on the target** over the
same structured exec channel as everything else — no second connection and no
shell string:

```sh
# what apm runs on the target when an instance starts
tailscale serve --bg --https=8443 http://127.0.0.1:4800
# and when it stops
tailscale serve --https=8443 http://127.0.0.1:4800 off
```

The two ports are allocated separately and on purpose: `4800…` is where `t3`
listens on the target's loopback address (that is `T3Instance.port`), and
`8443…` is the tailnet HTTPS listener that appears in the URL. Keeping them
apart means a service that binds more than loopback can never collide with
tailscaled's own listener. apm skips HTTPS ports the target already serves, so
several instances coexist.

Funnel is never enabled. After publishing, apm re-reads `tailscale serve
status --json`; if the port turns out to be funnelled to the public internet the
endpoint is withdrawn again and the start fails rather than handing you a public
URL.

### Endpoint scopes and the Open link

`ServiceEndpoint.scope` decides what the Open button means, and the instance
card spells it out rather than leaving you to read the URL:

- **published** — the target's own address. This is what another device on the
  tailnet needs, and what a remote instance should normally have.
- **forwarded** — the transport forwards a port on _this_ machine to the
  target. The link works here and nowhere else; the card says so.
- **loopback** — the local target only. apm **refuses** a loopback endpoint for
  a remote instance (`endpoint-failed`, HTTP 502): a machine somewhere else is
  never reachable on this machine's own loopback address.

apm never assembles a remote URL. `T3Instance.url` is copied from
`EndpointHandle.endpoint.url` and is `null` until the instance actually answers.

## Pairing and authentication

Authentication is T3's own, and apm stays out of it.

`t3 serve` prints a one-time owner pairing token when it starts — but apm
starts it headlessly and deliberately never reads its output, so that first
token is not something you can go and look at. **Mint a fresh 15-minute token
on the target instead:**

```sh
# on the target, for a running instance
apm pair
```

`apm pair` locally finds the live `t3 serve` process whose base directory is an
immediate child of APM's managed T3 directory, matches its backend port to the
target's published Tailscale Serve endpoint, and runs `t3 pair` with that exact
base directory, `--ttl 15m` and `--tailscale --tailscale-serve-port <port>`.
The tailscale flags make T3 itself build the pairing URL from the published
tailnet endpoint, so both the URL and the QR code printed in this terminal are
the ones another tailnet device should open. Any localhost origin an older T3
still prints in text is additionally replaced with the published endpoint.

This requires a T3 Code version whose `t3 pair` supports `--tailscale`; with an
older `t3`, `apm pair` fails with a clear message asking you to upgrade.

Process discovery requires Linux `/proc`; Linux and WSL are the supported
target contexts for `apm pair`. The command fails closed on other platforms.

With one running managed instance, selection is automatic. With several,
`apm pair` refuses to guess, lists their ids and ports, and asks for an exact
id:

```sh
apm pair <instance-id>
```

So, end to end:

1. Start the instance from the dashboard.
2. On the target, run `apm pair` (or select the exact id it lists).
3. On the device you want to use, open the published pairing URL from that
   command. T3 then keeps a session for that device.
4. Every later visit from that device uses the session, not the token. Mint a
   new token per device; the short `--ttl` keeps an unused one from lingering.

`apm pair` holds T3's output in memory only long enough to replace the local
URL and writes it directly to the invoking terminal. **The token is never
persisted, logged, forwarded to the hub daemon or included in API state.** The
headless managed instance's startup output remains unread, unstreamed and
unlogged.

If local discovery or endpoint matching needs troubleshooting, the previous
raw command remains available. Copy the exact base directory and published URL
from the instance card, then run (using the HTTPS port of the published URL):

```sh
t3 pair --base-dir <exact base dir> --ttl 15m --tailscale --tailscale-serve-port <https port>
```

Without the tailscale flags T3 prints a localhost URL and QR code in this
fallback flow; use its token at the
published endpoint from the card. Do not use plain `t3 pair`: it operates on
T3's default environment, not the APM-managed instance.

The apm dashboard's own bearer token is unrelated to T3's pairing token, and
neither ever appears in the other's UI.

## Revoking remote access

From the widest hammer to the narrowest:

- **Revoke the target** on the dashboard's Targets page. The entry leaves
  `targets.json` and apm closes the connection right away: closing a transport
  revokes the endpoints it published (except a managed instance's — see below)
  and ends the ptys it opened, nothing can be started there again, and work
  still in flight fails with `target-closed`. A managed T3 instance is
  deliberately detached, so revoking does **not** terminate it — stop the
  instance first if you want the process gone, or clean it up on the target
  (below). (Setting `approved: false` by hand has the same effect on
  selection — `target-not-approved` — but only from the next daemon start.)
- **Remove the device from your tailnet** (or revoke its node key). The
  transport can no longer reach the target and the endpoint stops resolving.
- **Stop the instance** from the dashboard: apm sends `SIGTERM`, escalates to
  `SIGKILL`, and withdraws the serve configuration
  (`tailscale serve --https=<port> … off`), so the URL stops answering. If that
  withdrawal fails, the card says so instead of pretending the URL is gone —
  run the `off` command on the target yourself, or `tailscale serve reset` to
  clear every serve entry on that machine.
- **Revoke a paired device** inside T3 itself — pairing sessions belong to T3,
  and stopping an instance does not by itself invalidate a device that paired
  with a previous run of it.
- **Remove the instance** in apm. Its base dir is deliberately left on the
  target; delete `~/.local/share/apm/t3/<id>` there if you want its state gone.

## Known limitations

- Re-adoption happens when the daemon starts. A target that is unreachable at
  that moment cannot be inspected, so its instances are reported stopped with
  the reason; once the target is back, press **Start** — it stops whatever the
  record still names before launching, so nothing is doubled up.
- The instance's working directory is its base dir on the target, as it is
  locally; per-instance project directories are not modelled yet.
- apm cannot enumerate the target's busy TCP ports, so it picks a port that no
  serve entry is already proxying to. That covers instances it published
  itself; if something unrelated holds the port, `t3` fails to bind and the
  card says so, naming the port. Starting again takes the next one.

## When a target keeps a process it should not have

Nothing apm starts on a target through a pty (`apm run` sessions) is meant to
outlive the connection that started it, and a managed T3 instance — the one
deliberate exception — is meant to outlive it _only under its record_. Four
things keep that honest:

- the remote agent kills its whole process group on `SIGHUP`, on stdin EOF and
  on its own exit, so a dropped SSH connection cannot leave a pty server
  behind even if that server ignores hangups;
- a managed instance is the narrow exception: it is spawned in its own session
  with a state file in its base dir, and only stop/delete (or a start that
  replaces it) terminates it — after the target verified the recorded pid
  still is that process;
- a start stops whatever the instance's record still names before spawning,
  steps over ports an existing serve entry already proxies to, and withdraws
  entries in apm's own port ranges whose backend no longer answers, so
  leftovers get reclaimed instead of accumulating;
- re-adoption reuses the instance's surviving serve entry rather than stacking
  a second listener onto the same backend.

If a machine was left in a bad state by an older build, clean it by hand:

```sh
# on the target
tailscale serve status          # what is still published
tailscale serve reset           # drop every serve entry on this machine
pkill -f 't3 serve'             # and any server left holding a port
```

## Manual two-device check

The live test this feature is gated on, in order:

1. On the target: install T3 Code, confirm `t3 --version` works, make sure an
   apm profile there is active, and confirm `tailscale serve status` runs
   without sudo (`sudo tailscale set --operator=$USER` if it does not).
2. On the hub: open **Targets**, find the machine under "On your tailnet",
   press **Add**, and confirm it appears under Registered and in
   `GET /api/targets` with `approved: true` and the four capabilities — without
   restarting the daemon.
3. Dashboard → **T3 Instances** → **New instance**. Pick the remote target; the
   per-provider profile selects must fill with the **target's** profiles, not
   this machine's.
4. Create, then **Start**. The card must show the target's name, a `remote`
   badge, a `published` endpoint badge, and a URL that is not `127.0.0.1`.
5. On the target, run `apm pair`. On a second tailnet device, open the
   published pairing URL it prints, complete pairing, open a project and
   confirm the expected provider account is the one in use. If two instances
   run on the target, confirm the bare command refuses to choose and rerun it
   with the exact instance id it lists.
6. Confirm the URL is **not** reachable from outside the tailnet, and that
   `tailscale serve status` on the target lists it without any Funnel entry.
7. **Stop** from the hub. The card returns to `stopped` with no link, the URL
   stops answering on the second device, and `tailscale serve status` on the
   target no longer lists the port.
8. Kill the target's connection while an instance runs (drop it from the
   tailnet). The card must flip to `unhealthy` with the endpoint's reason, not
   keep offering a dead link.
9. Start an instance while the target has no `t3` installed, and again with
   Tailscale stopped. Both must fail fast with a message naming the missing
   prerequisite rather than hanging.
10. Let a start time out (stop `t3` from coming up), then press **Start**
    again. The second attempt must go healthy and stay healthy, and
    `tailscale serve status` on the target must not accumulate a stale entry
    from the abandoned attempt.
11. **The survival check.** With an instance running and paired, restart apm
    on the hub — once gracefully (`apm stop`) and once by killing it outright
    (`pkill -9 -f 'apm'`). While apm is down, the instance must keep answering
    on its published URL from the second device. After each restart the card
    must return to **running** with the same URL, without pressing Start
    (`pgrep -af 't3 serve'` on the target shows the same pid throughout), and
    `tailscale serve status` must list exactly one entry for it — no
    duplicates piling up. Then kill `t3 serve` on the target while apm is
    down and restart apm: the card must say **stopped** with a reason naming
    the death, and pressing **Start** must bring it back cleanly.
12. **Stop and delete across restarts.** Start an instance, restart apm, then
    press **Stop**: the process on the target must end and the serve entry
    disappear, even though this daemon never spawned it. **Revoke** the
    target on the Targets page while another instance runs on it. It must
    disappear from the T3 target picker at once and `targets.json` must no
    longer list it; the detached instance deliberately stays up on the target
    — clean it there (`apm pair` still finds it, `pkill -f 't3 serve'` +
    `tailscale serve reset` remove it). Starting anything on the revoked
    target afterwards must fail rather than reach the machine. Stop Tailscale
    on the hub and reload the Targets page: it must say it cannot read the
    tailnet instead of showing an empty one, and the registered targets must
    still be listed.
