# Release notes - 1.0.0-preview.15

## Optional primary and backup tunnels

An explicit desktop-console opt-in can maintain two independent Cloudflare
Quick Tunnel processes for the same Windows gateway. The feature is off by
default. Each slot has separate ownership, health and repair state; a fresh
public probe must identify the current gateway boot before its address is
offered. Repair is bounded and leaves the sibling slot alone. Unknown process
ownership or uncertain termination blocks replacement.

On a full phone-page reload, a reminder can offer to copy the latest verified
alternate address. First visits use an optional Settings entry and do not
automatically open the reminder. Conversation changes, reconnections and
returning to a background tab do not trigger that modal. Copy
requires a tap, and there is no automatic failover navigation or message resend.

The copied address contains no access key, encryption fragment or recovery
token. A different hostname has separate browser cookies and encryption-key
storage. It must already have login and encryption-key setup and be tested
before its saved bare address can be relied on. Copying is not preparation, and
this feature does not transfer credentials automatically. A replaced hostname
needs setup again. Both paths still share the PC, internet connection, gateway
and Cloudflare; they cannot cover failure of those shared dependencies.

Older single-tunnel sessions are not adopted without ownership proof. Enabling
the managed pair may require one desktop Stop/Start cycle. Named/fixed tunnels,
private-only connections and other operating systems do not automatically gain
a backup. See [the dual-tunnel guide](docs/DUAL-TUNNELS.md) for configuration,
disable/refresh behavior and verification limits.

## Safer diagnostic exports

Diagnostic device summaries now contain only a fixed device/browser
classification, timestamps and state flags. Stored device labels are omitted:
unknown-device labels can contain a source IP address, and custom labels may
contain other private information. Local labels, device records and pairing
behavior are unchanged.

The exporter still applies redaction rules and checks collected local
credentials before writing a bundle. This is not a guarantee that every private
detail or message body has been removed from status or log text. The bundle and
desktop success message now explain this limit and ask for manual review before
sharing. [SECURITY.md](SECURITY.md) describes minimal public bug reports and asks
for synthetic examples when a redaction rule misses private content. Do not post
an unreviewed bundle, raw logs or complete connection links.

## Clearer DSH discovery failures

Runtime status distinguishes a successful scan with no recognized DSH process
from a timed-out or failed process inventory. The existing target views show
fixed timeout/error guidance in Chinese, English and Spanish, including a
console language change while the status is cached. Failure explanations use fixed
wording, and the inventory summary exposes only a bounded status and the
eight-second command timeout; it does not copy OS error messages, command lines
or raw process output.

The production deadline remains eight seconds per inventory command. A failed
or incomplete scan does not establish runtime identity or authorize access to an
unverified listener. Successful refreshes clear obsolete failure status. These
diagnostic changes do not start, stop or reconfigure DSH.

## Installation and requirements

The source package and planned Windows installer, source archive and plugin
tarball share version `1.0.0-preview.15`. Use only assets actually published on
[Releases](https://github.com/jyb114/pocket-bridge/releases); a source version is
not evidence that release binaries are available. The plugin tarball for this
version is named `pocket-bridge-1.0.0-preview.15.tgz`. Follow the
[plugin guide](docs/DSH-PLUGIN.md) for the correct host profile and installation
procedure.

The gateway requires a genuine **Node.js 24+** runtime. Public internet tunnels
also require **cloudflared**; private HTTPS does not. The Windows installer
supplies those runtimes, while the plugin tarball does not. DSH and model
credentials remain separate. Managed configuration, keys, paired devices and
uploads remain outside the replaceable plugin package. Earlier releases remain
available.

## Verification boundaries

Dual-tunnel regressions use synthetic children, process queries, clocks and
public-probe responses. Mobile reminders, clipboard handling, stale results,
visibility and credential-context changes use controlled browser/DOM fixtures.
These do not establish a working public backup on a real phone.

The new offline regression runs the actual exporter with synthetic credentials,
device records and logs in an owned temporary directory. It covers public and
private IPv4, compressed and mapped IPv6, arbitrary labels, stdout and file
output, useful summary preservation and residual private-key-block refusal.
Runtime regressions cover empty, failed, timed-out and recovered inventory
outcomes, closed diagnostic fields and retained identity checks. Source-renderer
fixtures verify the visible guidance, recovery and cached language changes;
they are not physical-phone or pixel-level browser acceptance. No real user's
logs or device records are needed for these tests.

The cookie regression injects synthetic egress data before the gateway imports
its routing module and refuses unexpected fetches or non-loopback TCP. This
test does not need to query a public-IP service.

Publication still requires independent Windows CI for the exact commit,
verified plugin packaging and the existing compiled-installer smoke checks.
Linux-only results do not establish those Windows gates. Physical-phone,
cellular/public-tunnel and model-provider acceptance remain separate; earlier
evidence belongs to the exact revisions recorded in the
[plugin acceptance record](docs/DSH-PLUGIN-ACCEPTANCE.md) and
[compatibility matrix](docs/DSH-COMPATIBILITY.md).

No telemetry or third-party npm runtime dependency is added. Local
control authentication and encrypted phone-content boundaries are unchanged.
This remains an unofficial, DSH-only preview.
