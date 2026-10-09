# Pocket Bridge DSH plugin

Pocket Bridge is an independent, unofficial project. The optional DSH plugin
adds a local connection panel to the existing phone gateway. The Windows
installer and lightweight phone website remain available. This plugin does not
include DeepSeek Harness and does not provide a second model service.

The panel offers a phone connection, gateway status, explicit start and pause
actions, and connection diagnostics on the tested DSH hosts below. A successful
local health check is not proof that a phone can connect through its network.
The plugin must confirm the selected gateway identity and its DSH target before
offering a connection or changing the gateway state.

## Installation

Install a tested release tarball through your DSH plugin manager. No separate
npm publication is required. Preview.13's versioned release URL is:

```text
dsh plugin --profile web add https://github.com/jyb114/pocket-bridge/releases/download/v1.0.0-preview.13/pocket-bridge-1.0.0-preview.13.tgz
```

That command targets an npm DSH Web profile. A desktop application's plugin
manager owns its own profile: install the same tarball through that manager
when supported, rather than assuming that `--profile web` changes the desktop
application. Follow the host's normal restart instructions after installation.
Do not force-close an active DSH task merely to reload the plugin.

The package has an installable `dsh.bundle` patch and a Web client entry.
Its gateway stays CommonJS; only the nested `dsh-plugin` entry is an ES module.
Official DSH libraries are host peers, and React is supplied by the DSH browser
host. No install, prepare, or packaging lifecycle hooks run to start a gateway,
download a binary, alter a profile, or change a firewall rule.

The plugin currently declares `@deepseek-ai/cordis` `~4.0.4`,
`@deepseek-ai/schemastery` `~3.18.4`, and
`@deepseek-ai/dsh-home-paths` `0.1.7-rc.2 || 0.2.0-rc.2` as host peers.
These declarations identify the intended package combinations; they are not
a compatibility promise for every desktop wrapper or another DSH release.
The settings entry also depends on the host exposing its Web settings UI.

The gateway requires Node.js 24 or newer. A temporary internet tunnel also
requires cloudflared; private HTTPS does not. The Windows installer supplies the two runtimes; the
plugin source tarball does not bundle their binaries. The plugin uses a genuine
Node executable from the selected Windows installation's runtime, the current
non-Electron Node process, or a validated PATH candidate. An Electron executable
is not used to launch another desktop window as a daemon. Runtime discovery
does not change global PATH or the user's process environment.

If Start reports `node-unavailable` or `node-24-required`, install genuine
Node.js 24 or newer, restart DSH when its tasks permit, and retry Start bridge.
The panel does not assume that a plugin-only installation has a Windows shortcut.
Diagnostics stays read-only: it does not probe Node or cloudflared executables,
start child processes, or prepare the managed gateway directory. Its Node check
is unknown unless the last start attempt reported a runtime failure, which is
labeled as a previous result rather than a new dependency check.

If cloudflared is unavailable and no private HTTPS entrance is configured,
the local gateway can run while the secure phone connection remains unavailable.
The real npm-host tests exercised this state and the panel reported it rather
than displaying a usable HTTPS connection. Configure a supported secure
entrance through the bridge's controls; do not treat a running listener as a
working remote connection.

## Existing Windows installation

If Pocket Bridge is already installed, set the plugin's `bridgeDirectory` to
that exact installation directory, for example `D:\Pocket Bridge`. The plugin
should reuse the selected instance instead of starting a duplicate gateway or
adopting an unrelated listener that happens to use the same port.

A gateway serving another DSH instance is a target mismatch. Keep it running
for its current user and select the correct installation. Changing a port or
stopping a foreign process is not a safe substitute for identifying the target.

A gateway started by this plugin is pinned to its host DSH port. Reusing an
already running standalone gateway verifies the current target but preserves
its previous runtime-selection policy; it does not restart that gateway to
change the policy.

The connection contains private authorization material. Reveal or copy it
only when intentionally connecting a trusted phone. Do not publish a screenshot
that includes the live connection, its QR code, or credentials.

## Package-managed gateway and retained data

When no installation directory is configured, the plugin uses a stable
gateway directory under `dshHomePath('pocket-bridge', 'gateway')`. It must
materialize that directory only after an explicit Start action and after
confirming that no selected gateway is already running. The generated
`dsh-plugin/gateway-source-manifest.json` records each public source file's
relative path, size and SHA-256 hash so runtime copying can validate the
complete inventory and reject traversal, links or changed package bytes.

The stable directory is separate from the replaceable plugin package. It may
contain connection keys, configuration, devices, logs and uploads after the
user starts the gateway. Those files are not included in the distributed
tarball. The local `.pocket-bridge-managed.json` marker is runtime state and is
not a distributed package member.

Disabling or uninstalling the plugin unregisters its panel and local handlers
while preserving gateway data and an explicitly selected Windows installation.
Real native-host uninstall and reinstallation retained the test configuration,
access key and encryption key byte for byte. Broader retention checks use owned
fixtures; they are separate evidence from the operated native host.
Pause the gateway through its own controls if you want to stop phone access.
Removing a plugin must not terminate DSH, its tasks, or unrelated processes.
Deleting retained data is a separate deliberate operation; back up anything
you need before removing a stable gateway directory.

## Privacy and connection limits

The phone gateway supports application-layer encrypted DSH messages and file
routes. Check the current gateway's reported capabilities and encryption state;
the plugin does not convert a plaintext route into an encrypted one by naming
it secure. No connection should be offered while encryption readiness is
unknown or the gateway targets a different DSH listener.

Cloudflare and other HTTPS reverse proxies terminate TLS in their respective
deployment modes. They can observe connection metadata and traffic outside
the encrypted routes. A passive observer sees ciphertext on the encrypted
routes when the original phone page and scripts are trusted. An active provider
that changes the initially delivered page or JavaScript remains a trust
boundary. This is not a claim that every byte is end-to-end encrypted or that
a tunnel operator can never access any information. See [Security](../SECURITY.md)
and the gateway's threat-model documentation before choosing a public or
private network path.

The panel should not contact a central telemetry, announcement or feedback
service by default. Diagnostics must redact connection values, device secrets,
private configuration and model credentials. A green local check does not
certify a public tunnel, a physical phone, or model image support.

## Compatibility and real acceptance

Plugin acceptance is separate from the already tested standalone gateway.
Adding a bundle manifest or passing package tests does not prove that a
particular DSH host can install, render, send, or recover after a restart.

This record separates operated npm Web hosts from the native desktop host.
The package was installed with the real DSH CLI for npm hosts and through the
original native application's plugin manager for the desktop host. Settings
and phone controls were actually operated against isolated DSH homes. This is not a
claim of complete feature parity, every old-version combination, another
desktop wrapper, or future-release compatibility.

| Exact host | Real operations completed | Remaining acceptance |
| --- | --- | --- |
| npm DSH Web 0.1.7-rc.2 on Windows | CLI tarball installation and upgrade; real Settings Start, Refresh, diagnostics, Stop cancellation/confirmation and reveal/copy/hide. Over encrypted HTTPS in a 390 x 844 browser: add a computer workspace, create a conversation, select the Account model and Low reasoning, send a prompt and receive its actual reply. | Physical phone, camera scan, cellular network, full file-transfer and plugin-specific approval/question acceptance are not established by these operations. |
| npm DSH Web 0.2.0-rc.2 on Windows | CLI tarball installation and upgrade; the same real Settings actions and private connection controls. Over encrypted HTTPS: create a workspace/conversation, select the model, receive a real reply, preview and download a workspace file with identical bytes, upload a text attachment and receive the model's actual reply after reading it. | Physical phone, camera scan, cellular network and plugin-specific approval/question acceptance remain unverified. |
| Native DSH 0.1.7-rc.2 desktop on Windows | Install, enable, uninstall and reinstall through the original desktop plugin manager. Operate native Settings Start, Stop, diagnostics and desktop-controls opening. Verify that Stop leaves DSH running, and that state changes clear old diagnostics. Over encrypted HTTPS: add a workspace/conversation, select the Account model and receive its real reply. Configuration and both connection secrets survived removal unchanged. | This is the actual official Electron application in an isolated profile, operated through its renderer. It does not establish support for another wrapper, future release, physical phone or every desktop plugin. |

Each npm host used its own stable `DSH_HOME/pocket-bridge/gateway` instance;
existing unrelated listeners on ports 8080 and 8081 were not adopted. A real
missing-cloudflared run confirmed the distinction between a running local
gateway and an unavailable HTTPS entrance. The QR was rendered at 211 x 211
pixels and independently decoded from its browser screenshot with ZXing;
the decoded connection exactly matched the expected private entrance. This
tests the rendered code, not a physical phone camera. See the
[plugin acceptance record](DSH-PLUGIN-ACCEPTANCE.md) for lifecycle and failure
checks, including the boundaries that were not tested.

Package and simulated checks are separate evidence: an actual `npm pack`
tarball was independently listed and read with system `tar`; hashes, required
exports, dependency closure and exclusion of private or retired files were
verified. Isolated tests cover altered source bytes, missing dependencies,
prohibited lifecycle hooks, linked files, traversal, repeated members, managed
source retention and host admission. These do not replace the real host and
phone flows in the table. No unit fixture is described as native desktop,
public tunnel or physical-device acceptance.

Exercise failure states too: an occupied gateway port, no DSH HTTP service,
wrong target, missing runtime, changed upstream port, unavailable tunnel,
expired authorization, closed browser, repeated clicks, and plugin unload
during an operation. Record what was actually exercised, including unverified
parts, rather than marking the whole combination compatible from startup alone.

## Building a public plugin tarball

From a reviewed source checkout, stage the intended public files in Git first.
The builder reads `git ls-files -z`; it never publishes untracked local data.
Use a fresh artifact directory outside the checkout:

```text
node scripts/build-dsh-plugin.js D:\Bridge-Releases\plugin-preview
node scripts/test-dsh-plugin-package.js
```

The builder applies the DSH release profile and a fixed public-source allowlist.
It excludes tests, artifacts, runtime binaries, private reminders, configuration,
logs, uploads, credentials, and retired Codex/Dot integrations. It runs
`npm pack --ignore-scripts` in an owned temporary stage, reads the real tarball,
checks dependency closure, verifies every source-manifest hash, and fails if
source bytes change during packaging. It produces a `.tgz`, a SHA-256 sidecar,
and a package-verification JSON record. Packaging is not live DSH acceptance.

The package test uses isolated copies and creates its own test credentials and
artifacts. Set process-local temporary paths and `npm_config_cache` to your
preferred development disk before running it. It does not install the plugin
into the user's DSH, start a gateway, stop a process, change a Git index, or
publish anything.

## Community marketplace submission

The community `dsh-market` app obtains entries from
[`awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin).
Submit one `data/plugins/jyb114__pocket-bridge.yml` file through a pull request
after the plugin's claimed behavior has passed real acceptance. Do not edit
the generated README lists or submit the entry to the marketplace app itself.

The [current contribution rules](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)
require an installable `dsh.bundle`, working code, a repository at least one
day old, a `dsh-plugin` topic, an accurate English description, passing CI,
and maintainer review. npm publishing is optional: a verified prebuilt `.tgz`
on GitHub Releases can be declared with `tarball`. A pinned release URL avoids
breaking a versioned filename when the latest release changes.

[The catalog template in the source repository](https://github.com/jyb114/pocket-bridge/blob/main/packaging/dsh-plugin/catalog-entry.example.yml)
contains placeholders and is not a ready submission. Replace them with the
actual accepted release, verify the public download, and describe only the
features that were tested. Add `screenshots.json` with 1-8 repository-relative
images if you want to control the marketplace screenshots. Capture a clean
test fixture rather than a user's live secrets or conversation.
