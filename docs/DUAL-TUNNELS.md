# Optional primary and backup tunnels

This feature is off by default. It supports the Windows package's Cloudflare
Quick Tunnel mode. Fixed/named tunnels, unsupported providers, private-only
connections and other operating systems do not acquire an automatic backup.
The computer console exposes the opt-in. Source configuration uses
`"tunnelBackup": { "enabled": true }` alongside a supported Quick Tunnel policy.

## What it provides

Two separately owned `cloudflared` processes connect to the same existing
loopback gateway port. Each has its own temporary hostname, generated config,
logs, process-creation identity, health checks and repair state. No second DSH
or second gateway is launched. Repairing one slot does not stop its sibling.

The gateway checks the slots about once a minute. A new hostname is offered
only after an HTTPS request through that public hostname returns the gateway's
204 probe and current boot marker. A process merely being alive is insufficient.
Readiness expires after three minutes and is invalidated by a gateway boot or
target-port change. This checks the computer-to-public-hostname route, not the
phone's current network or DSH's ability to execute an instruction.

A confirmed process exit permits repair. A live process normally needs three
spaced failed checks, and a new process has a startup grace period, before its
slot is rebuilt. Failed starts use bounded retry delays. Unknown ownership,
uncertain process termination or an interrupted spawn blocks replacement
instead of creating an untracked third endpoint.

An old single-tunnel process has no per-installation generation marker. When
enabling this feature in an already running older session, the existing tunnel
is left alive. Stop and then start the bridge from its desktop controls once to
establish the managed pair. No process is adopted solely because its name,
executable or apparent target matches.

## Saving and using the backup

On a full mobile-page reload, the page can prompt you to copy the latest
verified alternate address. Internal conversation changes, SPA navigation,
reconnection and returning to a background tab do not trigger the same modal.
First visits use an optional Settings entry and do not automatically open the
reminder. Copy requires your tap.

The copied address contains no access key, encryption fragment or recovery
token. A different hostname has separate browser login cookies, encryption-key
storage, service worker and PWA state. The six-digit pairing code registers a
device but does not itself deliver the encryption key. The alternate origin
must have both login and encryption-key setup, and be tested before relying
on its saved bare address. Copying this address alone does not perform that
setup. This feature adds no automatic cross-origin credential transfer or
one-click preparation flow, and makes no claim that a browser is prepared.

When a hostname is replaced, prepare the new origin again and save its current
bare address. A previously saved address can stop working; storage clearing,
private browsing, credential rotation, device revocation and expiry can also
require setup again. If the primary becomes unreachable, manually open the
saved backup. No automatic failover navigation or message resubmission occurs.

Disabling the backup retires only its verified owned process. That disable
request never revives a missing primary; a later explicit desktop Start or
primary refresh can restore the ordinary single primary without recreating
the backup. While the verified managed primary remains alive, periodic checks
continue to refresh its reachability. With backup disabled, a failed or exited
primary is reported unavailable and is not automatically rebuilt. The public
`tunnelProvider: "none"` policy does not discover, probe or recreate either
public slot. As with the existing policy, `none` alone does not prove that a
previous external process was stopped or revoke previously issued credentials.
Use the verified desktop Stop control before relying on local-only operation.

## Limits and verification

Both addresses depend on the same PC, internet connection, gateway and
Cloudflare service. PC shutdown, network loss or a provider-wide outage can
make both unavailable. Quick Tunnels have no uptime guarantee and change
hostnames on creation. Cloudflare documents a 200 in-flight-request limit and
no SSE support. The bundled 2026.9.1 Quick Tunnel implementation uses one edge
connection per process; the four-connection description for regular named
tunnels does not apply to Quick Tunnels.

Sources: [Quick Tunnel documentation](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)
and [bundled-version Quick Tunnel implementation](https://github.com/cloudflare/cloudflared/blob/2026.9.1/cmd/cloudflared/tunnel/quick_tunnel.go).

Isolated tests use synthetic process queries, children, clocks and public-probe
responses, plus owned local HTTP fixtures for the probe contract. These tests
do not establish Windows native process behavior, a live provider endpoint,
real-phone recovery or cross-origin pairing acceptance. Those remain separate
acceptance steps requiring the appropriate environment and authorization.
