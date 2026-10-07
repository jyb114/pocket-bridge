# Optional private HTTPS

This preview contains a read-only Tailscale status module and optional private
HTTPS admission checks in the gateway. They are disabled by default. They do
not install Tailscale, sign in, configure Serve or Funnel, change network
settings, request certificates, start a listener, or provision a connection.
A positive configuration result is advisory; it does not prove that a phone
has connected successfully.

Tailscale Serve can expose a local service privately to permitted devices in a
tailnet. HTTPS is terminated by Tailscale on the serving computer. This can avoid
sending the initial web application through Cloudflare; application encryption
alone cannot protect a user from JavaScript replaced by the provider serving the
first page. The computer, browser, installed software, certificate authorities
and Tailscale control plane still belong to the trust model. This is not a claim
that any transport eliminates every threat. See the official
[Serve overview](https://tailscale.com/docs/features/tailscale-serve) and
[Serve CLI reference](https://tailscale.com/docs/reference/tailscale-cli/serve).

## Required owner setup

Install the official Tailscale application on the Windows computer and the
phone, and connect both to the intended tailnet. Review its access policy so
only intended devices may reach the serving computer. Enable MagicDNS and HTTPS
through Tailscale's documented owner controls. Tailscale-issued HTTPS names are
published in certificate transparency logs; choose a machine and tailnet name
that do not reveal sensitive information. The public certificate name does not
itself make Serve publicly accessible. See the official
[HTTPS instructions](https://tailscale.com/docs/how-to/set-up-https-certificates)
and [Windows installation guide](https://tailscale.com/docs/install/windows).

Do not use Funnel for this private connection. Do not reset existing Serve
configuration to make the status indicator pass. Existing applications and
other Serve or Funnel configurations must be reviewed separately by their owner.
This implementation conservatively refuses a positive result if it sees any
enabled Funnel entry, including foreground entries, and never changes them.

A manually provisioned connection uses one exact HTTPS origin such as
`https://bridge.example-tailnet.ts.net:8443` and a root reverse proxy to the
gateway's actual loopback port, for example `http://127.0.0.1:8081`. These are
examples, not installation commands or real credentials. The status module
requires an explicitly configured origin matching the client's own DNS name and
an exact port; it will not discover or recommend an arbitrary peer or hostname.
It accepts only a single root proxy with no additional mounts at that origin.
Hosted Tailscale Services and unknown configuration schemas are not supported
by this first status inspector.

## Read-only module contract

`scripts/tailscale-private-https.js` exports
`readStatus({ enabled, origin, gatewayPort })`. When disabled, it does not even
discover a client or run a subprocess. When explicitly enabled, it checks only
the supported official Windows installation locations and can execute only:

```text
tailscale version
tailscale status --json
tailscale serve status --json
```

Each command has a four-second deadline and a one-MiB output limit. Commands run
without a shell or visible window. Raw CLI output, authentication URLs, keys,
peer lists, account identity, addresses and stderr are not returned or logged.
The configured origin is intended for a local console only; it is not a public
status endpoint. Older clients whose Serve syntax predates version 1.52 and
unrecognized JSON structures receive explicit unavailable statuses.

The result contains `mode: "status-only"`, `enabled`, `installed`, `connected`,
the numeric client `version`, the validated configured `origin`, `gatewayPort`,
`configurationReady`, a fixed `code`, and these truthful invariants:

```json
{
  "gatewayAdmissionImplemented": false,
  "phoneVerified": false,
  "mutationPerformed": false
}
```

`configurationReady` means only that the sampled client was connected, its
HTTPS prerequisite metadata matched, and its sampled node Serve configuration
had one exact private proxy. It is neither authentication nor a promise that
the configuration remains unchanged. CLI or daemon failures and malformed
output produce fixed error codes without relaying private diagnostic text.

The gateway's local-console-only `GET /__private-https` endpoint exposes this
bounded status with `gatewayAdmissionImplemented: true` to distinguish the
integrated admission code from the standalone inspector. Other methods are
refused, and remote requests cannot use this endpoint. This override does not
change `phoneVerified: false` or turn advisory configuration into authentication.

## Gateway admission and remaining acceptance

The status module grants no request authority. The independent admission module
uses `config.privateHttps`, whose default is `{ "enabled": false, "origin": "" }`.
When disabled, requests for a `.ts.net` entrance are refused. When enabled, the
gateway admits only the exact configured HTTPS authority through a loopback
reverse proxy with matching forwarded host/HTTPS metadata. Applicable Origin
headers must match; writes and browser WebSocket upgrades require Origin.
Funnel-marked requests, duplicate security headers, management routes and
malformed or foreign authorities are refused before static pages or content.
Existing pairing, device proof, challenge and encrypted-content requirements
then still run. A `.ts.net` hostname is never classified as localhost. Tailscale
identity headers do not authenticate Pocket Bridge devices or authorize actions.

The native Tailscale TCP reverse proxy preserves the incoming Host and supplies
forwarding headers; loopback socket origin alone does not establish local
trust. An admitted request remains remote even if it matches a saved
desktop/self-client convenience record, including its decrypted in-process
request shim. Local console, health, stop, notification and management routes
remain unavailable through the private proxy. Forwarding metadata narrows
admission; it does not attest the sender's process. A malicious local program
that fabricates these headers must still satisfy application authentication,
proof and encryption. Do not generalize this into trusting all forwarded
headers or all `.ts.net` hosts. The upstream source contract is documented by
the official [Serve configuration types](https://github.com/tailscale/tailscale/blob/v1.102.4/ipn/serve.go)
and [reverse-proxy implementation](https://github.com/tailscale/tailscale/blob/v1.102.4/ipn/ipnlocal/serve.go).

Origin-scoped cookies, device enrollment, tickets, challenges, service-worker
state and encryption key handling still need real-phone acceptance at the new origin.
Do not reuse an old Cloudflare page to approve or deliver private credentials.
Do not put an application key in a command line, published screenshot or
status response. The phone client, access policy, HTTPS, pairing, encrypted
messages/files and unavailable local-management routes must be tested on a real
phone before compatibility or private-connection acceptance is claimed.

## Current machine result

The development computer has no installed Tailscale client or service. No
tailnet login, network change or private connection has been performed. Isolated
status/parser tests are separate from real Windows-client and phone acceptance.

For an additional real CLI check, the official Windows 1.102.4 MSI was downloaded
to a private D-drive test directory and verified against its official SHA-256
and valid Tailscale Authenticode signature. Only the embedded CLI file was
extracted from the read-only MSI database and cabinet; the installer was never
executed and no service was installed or started. The extracted, signed CLI
returned version `1.102.4`; both read-only status commands failed to connect to a
local daemon. This checks the official executable's behavior on this machine,
not tailnet connectivity, HTTPS, device pairing or phone operation. The artifact
source is the official [stable package index](https://pkgs.tailscale.com/stable/).
