# Release notes - 1.0.0-preview.14

## Safer startup and clearer recovery

The optional DSH plugin now explains missing or outdated **Node.js 24+** and
shows actionable startup recovery without assuming that a Windows shortcut exists.
Diagnostics remain read-only: an unprobed dependency is unknown, and a previous
failed start is identified as historical evidence rather than a new probe.

An explicit `tunnelProvider: "none"` no longer falls through to automatic
Cloudflare startup. Disabled policy skips public-tunnel discovery, reachability
probes and rebuilding; unsupported providers fail closed. Public work is cancelled
if the selected policy changes across asynchronous waits. The documented
`cloudflare` alias and supported dynamic/fixed modes remain available.

**Important:** disabling tunnel startup does not terminate an existing tunnel,
revoke old access, or disable LAN listeners. Gateway Stop pauses the gateway only;
an old tunnel can reconnect after restart. Verify and stop an existing tunnel
separately before relying on local-only operation. For isolated loopback-only
checks, also disable `enableLanAccess` and `lanHttps.enabled`.

## Easier local operation

- The desktop console labels disabled public startup accurately, hides disabled
  LAN HTTP entries, and shows configured private HTTPS separately.
- Console Chinese, English and Spanish switching updates navigation, headings
  and controls without a reload or an additional service request. Connection-card
  headings no longer collapse into one-character columns beside status badges.
- The plugin panel follows the host page/browser language and offers a panel-only
  override. Known recovery and diagnostic messages use the same language. The
  override lasts for the mounted panel and does not change DSH or browser settings.
- Plugin controls wrap within the space the DSH host provides. Primary actions
  precede detail fields, with complete prerequisites and lifecycle notes available
  in an expandable section. DSH's own navigation is unchanged.
- Lite startup and emergency update guidance remains available in Chinese,
  English and Spanish when the main language scripts cannot load. Update identity,
  capability, fingerprint verification, failure and retry rules are unchanged.

## Installation and requirements

Install `pocket-bridge-1.0.0-preview.14.tgz` through the supported DSH plugin
manager. For an npm DSH Web profile:

```text
dsh plugin --profile web add https://github.com/jyb114/pocket-bridge/releases/download/v1.0.0-preview.14/pocket-bridge-1.0.0-preview.14.tgz
```

A Web profile is separate from a desktop application's profile. Follow the host's
normal restart instructions when existing tasks permit. The plugin requires a
genuine **Node.js 24+** runtime. Public internet tunnels also need **cloudflared**;
private HTTPS does not. The Windows installer supplies those two runtimes, while
the plugin tarball does not. DSH and any model credentials remain separate.

Managed gateway configuration, keys, devices and uploads remain outside the
replaceable plugin package. Removing the plugin does not stop a running gateway
or remove retained data. Hiding a connection or stopping the gateway does not
revoke paired devices or copied links.

## Verification boundaries

Isolated regressions cover startup recovery, local control and stale-result
guards, disabled tunnel policies, connection-state presentation, live language
events, missing localization modules and failed verified-update transactions.
Publication requires exact-commit Windows CI, package verification and the
existing compiled-installer smoke checks. Passing those gates is not a substitute
for physical-phone, cellular/public-tunnel or model-provider acceptance.

The local browser checks use official npm DSH Web 0.2.0-rc.2 in an isolated
Linux/Chromium environment, without model credentials, model calls or public
exposure. Controlled failure fixtures are identified separately from actual DSH
operation. Earlier Windows/native-host and model-operation evidence belongs to
its recorded revision in the [plugin acceptance record](docs/DSH-PLUGIN-ACCEPTANCE.md)
and [compatibility matrix](docs/DSH-COMPATIBILITY.md); it is not a new universal
compatibility claim for this preview.

## Privacy and distribution

Local control authentication, loopback restrictions and encrypted phone-content
routes are unchanged. Tunnel providers still see metadata and serve the initial
page; an actively replaced page remains a separate trust boundary. No telemetry,
external translation/QR service, remote font or additional runtime dependency is
introduced. See [SECURITY.md](SECURITY.md).

The Windows installer, source archive and verified plugin tarball use the same
preview version. Packages exclude private configuration, authentication material,
logs, uploads, private QA harnesses and recovery files. Earlier releases remain
available. This remains an unofficial, DSH-only preview.
