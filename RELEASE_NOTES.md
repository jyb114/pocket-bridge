# Release notes - 1.0.0-preview.13

## Optional DSH plugin

Pocket Bridge now has an installable DSH plugin. Open **Settings → Pocket Bridge**
to start or pause phone access, reveal a private connection and locally generated
QR code, open the computer's controls, and diagnose the selected gateway.
The plugin reuses the existing lightweight phone interface and encrypted content
transport. It does not load the original desktop interface over the tunnel.

Download `pocket-bridge-1.0.0-preview.13.tgz` from this release and install it
through the desktop plugin manager. For the tested npm Web profiles:

```text
dsh plugin --profile web add https://github.com/jyb114/pocket-bridge/releases/download/v1.0.0-preview.13/pocket-bridge-1.0.0-preview.13.tgz
```

Use the host's normal reload or restart instructions. Installing into a Web
profile does not install into the desktop application's separate profile.
Do not close a running DSH task merely to reload a plugin.

## Connection and lifecycle

- Manage only an identified Pocket Bridge installation. Foreign listeners and
  a gateway serving another DSH instance are rejected rather than adopted.
- Pin a plugin-started gateway to its DSH host. Pausing phone access stops the
  bridge; it does not terminate DSH or its tasks.
- Keep managed gateway configuration, connection keys and uploads under DSH_HOME,
  outside the replaceable plugin package. Verify public source hashes before an
  installation or upgrade, and retain private state when removing the plugin.
- Keep connection secrets hidden until requested, then hide them after two
  minutes, loss of authorization, or connection changes. Hiding a displayed
  connection does not revoke it; rotate the connection through local controls
  when revocation is needed.
- Clear old diagnostics when gateway identity, target or connection state changes.
  Show the check time and require another check for the current state.

## Requirements and tested hosts

The plugin requires genuine **Node.js 24+**. Temporary internet tunnels also
require **cloudflared**. The Windows installer supplies both; the source plugin
tarball does not bundle their binaries or run install hooks. DSH and model
credentials remain separate requirements.

Actual plugin operations covered **native Windows DSH 0.1.7-rc.2**,
**npm DSH Web 0.1.7-rc.2**, and **npm DSH Web 0.2.0-rc.2** in isolated profiles.
Real encrypted HTTPS sessions returned model replies. The newer npm host also
completed an actual workspace-file download and an upload read by the model.
Native plugin removal and reinstallation retained configuration and both keys.
Read the [plugin acceptance record](docs/DSH-PLUGIN-ACCEPTANCE.md) for the exact
operations, lifecycle results and limitations.

These tests used a desktop browser with a 390 x 844 phone viewport. They do not
certify physical iPhone/Android, cellular networks, every plugin, arbitrary old
versions or future releases. Historical standalone gateway tests are recorded
separately in the [compatibility matrix](docs/DSH-COMPATIBILITY.md).

## Privacy and distribution

Plugin control routes require DSH authentication and direct loopback admission.
Origin-less native requests additionally use an in-memory host control token.
Conflicting Origins and relay headers remain rejected. No central telemetry,
external QR service, remote fonts or private notification helper is added.

Protected message and file routes use application-layer encryption. Tunnel
providers still see metadata and serve the initial page; an actively replaced
page is a separate trust boundary. This is not a claim that every byte is
end-to-end encrypted. See [SECURITY.md](SECURITY.md).

This release includes the Windows installer, source archive, verified plugin
tarball, package verification record and SHA256SUMS. Public packages exclude
personal reminders, connection links, credentials, configuration, logs and
uploads. New installers remain **DSH-only**; earlier combined Codex/Dot releases
remain available. Independent CI for the exact published commit remains required
before packaging and again before release publication.
