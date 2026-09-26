# Pocket Bridge

Pocket Bridge is an unofficial, free and open-source gateway that lets you use DeepSeek Harness (DSH) or OpenAI Codex running on your own Windows computer from a phone browser. It is not a hosted AI service and does not provide either AI product.

You do not need to register for a Pocket Bridge account or install a Pocket Bridge phone app. You **do** need the software you want to access already installed and signed in on the computer:

| What you want to use on your phone | What the computer needs |
| --- | --- |
| DeepSeek Harness | The DeepSeek Harness desktop application, installed and signed in |
| Codex | A working, signed-in OpenAI Codex desktop installation or compatible Codex CLI executable |
| Both | Both of the above |

**You do not have to install both products.** Pocket Bridge discovers and starts each available target separately. A ChatGPT website session, by itself, is not a local Codex installation. The Pocket Bridge installer includes its own Node.js runtime and cloudflared, but **does not include DeepSeek Harness, Codex, their accounts, or model access**. Those products may have separate eligibility, subscription, and usage costs. Your computer must remain on and connected to the internet while you use it remotely.

## Current status

- Windows x64 is the only packaged platform. The installer has been checked in an isolated Windows 11 environment; this is not a guarantee for every PC, target-app version, or network.
- The Windows installer is not code-signed. Windows SmartScreen may show an unknown-publisher warning. Download only from this repository's Releases page and compare its published SHA-256 checksum.
- Linux and macOS installers are not available. Some cross-platform source paths exist but have not been validated on those systems.
- The phone interface has been exercised on iPhone Safari. Other browsers and devices have not received equivalent real-device testing.

## Set up on Windows

1. Install and sign in to DeepSeek Harness, Codex, or both on the computer.
2. Download the Windows x64 Setup.exe from [Releases](https://github.com/jyb114/pocket-bridge/releases) and run it.
3. Open **Pocket Bridge** from the desktop or Start menu. Its local console shows target status and the current phone addresses. A target may be started from the console if it is installed but not running.
4. Copy the **complete** local-network or internet address from that console to your phone browser. Do not remove the access-key path or the #k= fragment. A six-digit pairing code by itself does not grant access to conversations.
5. On the same Wi-Fi, use the local-network address. Away from home, use the current tunnel address if the tunnel is connected.

There is no separate phone app to download. To add a shortcut on iPhone, open the complete address in Safari, tap **Share**, then **Add to Home Screen**. Browser storage for that shortcut may differ from Safari's; if it opens a pairing or login screen, use the current complete address again from within the shortcut. If the access key or tunnel domain changes, an old bookmark or home-screen shortcut may stop working. Return to the computer console for a new address.

The default internet route uses a temporary TryCloudflare tunnel. [Cloudflare describes Quick Tunnels as intended for testing and development, not production use](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/). Starting one can take time; its address can change or disappear, and it has no uptime guarantee. An address-change notification is only an aid, **not** a dependable recovery channel. A fixed-domain tunnel requires your own Cloudflare account and domain configuration; it is not needed for the default route.

## Run from source

Source users need Node.js 24 or newer. The Codex queue and lock controls use Node's global WebSocket API; this release enforces the same Node 24 baseline bundled with the Windows installer. For an internet tunnel, install cloudflared separately. The repository has no third-party npm dependencies, so **npm install is not needed**.

    git clone https://github.com/jyb114/pocket-bridge.git
    cd pocket-bridge
    node desktop/build.js
    node desktop/install-shortcut.js
    scripts\start-gateway.bat
    node scripts/self-check.js

Open the desktop shortcut or the computer's local console for the complete phone address. The self-check reports missing or unreachable target applications; a missing *other* target does not prevent use of the one you installed. Local runtime data and keys are generated on first use and are excluded from the source repository.

For development checks that do not require a live gateway, use:

    npm run ci
    node scripts/test-release-ready.js
    node scripts/secret-scan.js --strict

These checks are not a substitute for testing the installer and phone connection on your own devices.

## What the connection can and cannot protect

Pocket Bridge gives a remote browser powerful access to the software and files on your computer. **Treat the complete phone address as a credential; never post or share it.** Revoke devices or rotate the access key in the computer console if access may have leaked. Rotating only the `#k` encryption secret does not revoke device cookies or the access-key path; see [Security](SECURITY.md). The six-digit pairing code is an additional pairing step, not a replacement for the complete address.

| Route | Privacy and availability boundary |
| --- | --- |
| Local Wi-Fi over HTTP | Traffic stays off the Cloudflare tunnel, but HTTP is unencrypted on the local network. Optional local HTTPS uses a locally generated certificate that must be trusted correctly. |
| Temporary internet tunnel | Cloudflare terminates TLS and can see the URL path, cookies, metadata, and any request or response content not separately encrypted by Pocket Bridge. The address and availability can change. |
| Direct IPv6 over HTTP | Avoids Cloudflare but is still unencrypted over the internet and requires inbound IPv6 access. Do not treat it as a secure default. |

The #k= fragment is normally not sent in an HTTP request. It helps prove possession of a separate key, but it is **not** a guarantee against an intermediary that actively changes the first page or redirects the browser. Some Codex content channels and real-time streams use application-layer encryption; DeepSeek Harness real-time streams and some outgoing request bodies are covered, but other DSH API responses are not. **Do not assume all traffic is end-to-end encrypted or invisible to the tunnel provider.** See [Security](SECURITY.md) for the detailed threat model.

Optional notifications may contact web-push services, ntfy, or Bark. Optional balance checks can contact DeepSeek. Network-route detection may contact public-IP lookup services. The local console page itself does not load third-party assets. Do not rely on notifications to recover from a changed tunnel address.

Codex can hold an exclusive writer lock for a conversation. The phone may be able to observe a running task, but taking over writing by releasing the desktop lock can close or interrupt the desktop Codex process. Do not use that control during work you cannot afford to interrupt. The Codex WebSocket app-server interface is experimental and can change with Codex releases; DeepSeek Harness updates can also affect compatibility.

Releasing a phone-held conversation is a separate control and does not close desktop Codex. When all Codex phone connections disconnect, Pocket Bridge waits about 60 seconds before releasing its phone-side conversation holds; closing a browser tab is not an instant handback. Pocket Bridge applies a detected system proxy to the Codex service it launches, without automatically changing Windows user-wide proxy variables. The optional desktop-proxy troubleshooting action **does** change those user-wide variables and may affect other newly opened applications; read its warning before using it.

## Maintenance and disclosure

Installing a newer Windows package over an existing installation retains local configuration, keys, logs, uploads, and TLS data. Uninstalling also leaves those private files in place by default so they are not destroyed accidentally. Remove them manually only after confirming that you no longer need them.

Pocket Bridge is independent of DeepSeek, OpenAI, and Cloudflare and is not endorsed by them. Product names are used only to identify compatible software. See [Third-party notices](THIRD-PARTY-NOTICES.md) for bundled-component licenses, [Security](SECURITY.md) for disclosure instructions, and [LICENSE](LICENSE) for this project's MIT license.
