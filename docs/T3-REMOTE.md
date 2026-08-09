# Managed T3 instances on a remote target

A managed T3 instance normally runs on the machine that runs apm. It can also
run on any **approved execution target** (see [TARGETS.md](TARGETS.md)) — the
dashboard creates, starts, stops and monitors it from here, while the process,
the project files and the provider credentials all stay over there.

Everything crosses one seam: the target's transport. There is no SSH command
line, no Tailscale invocation and no credential copy anywhere in the T3 code
path.

## What runs where

|                      | local target                                 | remote target                                   |
| -------------------- | -------------------------------------------- | ----------------------------------------------- |
| process              | detached `t3 serve`, survives an apm restart | `t3 serve` on the transport's pty               |
| base dir             | `<dataDir>/t3/<id>`                          | `~/.local/share/apm/t3/<id>` **on the target**  |
| provider env         | injected here from the bound profiles        | injected **by the target** from its own profile |
| Open link            | `http://127.0.0.1:<port>`                    | whatever the target's endpoint publishes        |
| after an apm restart | re-adopted if still healthy                  | reported as stopped, start it again             |

## Prerequisites on the target

1. The machine is registered as an execution target and **approved** on this
   machine. An unapproved target runs nothing (`target-not-approved`, HTTP 403).
2. Its transport reports the `endpoint`, `pty`, `signal` and `profiles`
   capabilities. A target missing any of them is filtered out of the picker and
   refused by the API (`target-unsupported`, HTTP 400).
3. **T3 Code is installed on the target** and `t3` is on the PATH of the user
   the transport connects as. A missing binary is reported as `app-not-found`.
4. The target has its own **active provider profile**. Profile ids are
   target-scoped: the picker asks the target (`GET /api/targets/:id/profiles`)
   and never offers this machine's profiles for a remote instance.
5. `printenv` and `mkdir` exist on the target — apm resolves the target user's
   home and creates the instance-private base dir with them, as plain argv.
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

One remote instance binds **one** profile. A command carries a single profile
id and the target resolves it locally; injecting a second provider's
environment would mean moving credentials between machines, which the transport
contract deliberately makes impossible.

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

Authentication is T3's own, and apm stays out of it:

1. Start the instance from the dashboard. `t3 serve` issues a **one-time owner
   pairing token** on the target.
2. Open the instance's URL on the device you want to use (the same URL the card
   shows) and complete T3's pairing with that token. T3 then keeps a session
   for that device.
3. Every later visit from that device uses the session, not the token.

**apm never reads, stores, logs or forwards the pairing token.** A remote
instance's output is not streamed, not written to a log file on this machine and
not part of any API response — failures are reported from the process' exit
status instead. Read the token on the target, in the terminal or service log
where `t3 serve` prints it.

The apm dashboard's own bearer token is unrelated to T3's pairing token, and
neither ever appears in the other's UI.

## Revoking remote access

From the widest hammer to the narrowest:

- **Un-approve the target** in apm's target configuration. The registry then
  refuses every command for it (`target-not-approved`), so nothing can be
  started there again.
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

- A remote instance does not survive an apm restart. Its supervision is the
  transport's pty and endpoint, and both end with the daemon, so `adopt()`
  reports remote instances as stopped rather than linking an endpoint nobody is
  watching. Start it again from the dashboard.
- One bound profile per remote instance (see above).
- The instance's working directory is its base dir on the target, as it is
  locally; per-instance project directories are not modelled yet.
- apm cannot see which TCP ports are busy on the target, so it picks the
  instance's port from its own bookkeeping. If something else already holds it,
  `t3` fails to bind and the instance is reported unhealthy — stop it and start
  it again to take the next port.

## Manual two-device check

The live test this feature is gated on, in order:

1. On the target: install T3 Code, confirm `t3 --version` works, make sure an
   apm profile there is active, and confirm `tailscale serve status` runs
   without sudo (`sudo tailscale set --operator=$USER` if it does not).
2. On the hub: approve the target and confirm it appears in
   `GET /api/targets` with `approved: true` and the four capabilities.
3. Dashboard → **T3 Instances** → **New instance**. Pick the remote target; the
   profile select must fill with the **target's** profiles, not this machine's.
4. Create, then **Start**. The card must show the target's name, a `remote`
   badge, a `published` endpoint badge, and a URL that is not `127.0.0.1`.
5. On a second tailnet device, open that URL, complete T3 pairing with the token
   printed on the target, open a project and confirm the expected provider
   account is the one in use.
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
