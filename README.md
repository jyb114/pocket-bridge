# Pocket Bridge

Pocket Bridge is an unofficial, free and open-source gateway that lets you use DeepSeek Harness (DSH) or OpenAI Codex running on your own Windows computer from a phone browser. It is not a hosted AI service and does not provide either AI product.

You do not need to register for a Pocket Bridge account or install a Pocket Bridge phone app. You **do** need the software you want to access already installed and signed in on the computer:

| What you want to use on your phone | What the computer needs |
| --- | --- |
| DeepSeek Harness | The current DeepSeek Harness desktop build tested for this preview, installed and signed in |
| Codex | The current OpenAI Codex desktop installation tested for this preview, signed in |
| Both | Both of the above |

**You do not have to install both products.** Pocket Bridge discovers and starts each available target separately. A ChatGPT website session, by itself, is not a local Codex installation. The Pocket Bridge installer includes its own Node.js runtime and cloudflared, but **does not include DeepSeek Harness, Codex, their accounts, or model access**. Those products may have separate eligibility, subscription, and usage costs. Your computer must remain on and connected to the internet while you use it remotely.

## Current status

- Windows x64 is the only packaged platform. The installer has been checked in an isolated Windows 11 environment; this is not a guarantee for every PC, target-app version, or network.
- The Windows installer is not code-signed. Windows SmartScreen may show an unknown-publisher warning. Download only from this repository's Releases page and compare its published SHA-256 checksum.
- Linux and macOS installers are not available. Some cross-platform source paths exist but have not been validated on those systems.
- Earlier phone paths were exercised on iPhone Safari. This preview's revised DSH and Codex phone interfaces were operated in local mobile-sized browser sessions; acceptance of this release on iPhone Safari over 5G and on Android remains outstanding.

## Set up on Windows

1. Install and sign in to DeepSeek Harness, Codex, or both on the computer.
2. Download the Windows x64 Setup.exe from [Releases](https://github.com/jyb114/pocket-bridge/releases) and run it.
3. Open **Pocket Bridge** from the desktop or Start menu. Its local console shows target status and the current phone addresses. A target may be started from the console if it is installed but not running.
4. Copy the **complete** local-network or internet address from that console to your phone browser. Do not remove the access-key path or the #k= fragment. A six-digit pairing code by itself does not grant access to conversations.
5. On the same Wi-Fi, use the local-network address. Away from home, use the current tunnel address if the tunnel is connected.

There is no separate phone app to download. To add a shortcut on iPhone, open the complete address in Safari, tap **Share**, then **Add to Home Screen**. Browser storage for that shortcut may differ from Safari's; if it opens a pairing or login screen, use the current complete address again from within the shortcut. If the access key or tunnel domain changes, an old bookmark or home-screen shortcut may stop working. Return to the computer console for a new address.

The default internet route uses a temporary TryCloudflare tunnel. [Cloudflare describes Quick Tunnels as intended for testing and development, not production use](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/). Starting one can take time; its address can change or disappear, and it has no uptime guarantee. An address-change notification is only an aid, **not** a dependable recovery channel. A fixed-domain tunnel requires your own Cloudflare account and domain configuration; it is not needed for the default route.

This preview starts only Cloudflare tunnels. The former ngrok fallback is disabled. Do not place an arbitrary reverse proxy in front of the gateway: a proxy that rewrites the public Host to a local address and removes forwarding headers can make a remote request appear local. See [SECURITY.md](SECURITY.md).

## Tested DSH desktop scope

This preview was operated with the **DSH 0.1.7-rc.2 desktop build installed on the test PC**. Pocket Bridge checks the running app and its HTTP listener before connecting; the local console and phone target list show the detected edition and version. Other desktop versions are unverified. Actual npm Web testing has partial results below; complete end-to-end acceptance has not been achieved and those distributions are **not claimed as fully supported**. Protocol inspection and adapter fixtures do not establish real compatibility.

For the tested desktop runtime, the internet phone link opens Pocket Bridge's own DSH phone interface before the official plugin bundle loads. It keeps a familiar project, conversation and composer layout, while the computer's DSH still performs the work. The bridge-owned page lists and creates projects and conversations; reads paged history, live replies, reasoning and tool activity; sends prompts and approval/question replies; and browses, uploads and downloads files through authenticated encrypted endpoints. An uploaded file is attached only when its receipt is sent with a prompt. The bridge-owned page is much smaller than the official plugin frontend and requests no official DSH `/plugins/` or `/assets/` modules during initial use. The original desktop view remains available with `view=classic`. On a local HTTP page without browser WebCrypto, the original DSH frontend remains the default.

The file browser downloads files inside the selected conversation's verified computer workspace. DSH's uploaded attachment records contain no workspace path or public download API, so a pathless attachment in the transcript is shown as a file label rather than a download link.

Actual local npm runtimes 0.1.0-rc.8, 0.1.1-rc.2, 0.1.7-rc.2, and 0.2.0-rc.2 were operated through the phone interface at a mobile browser viewport. Project and conversation creation worked; the model service rejected the supplied credentials with 401, so successful replies, reasoning, and real approval/question completion remain unverified. Workspace browsing and text-file reading were exercised; operating-system download completion remains unverified. The old runtimes required compatible published Cordis dependency pins. This is partial acceptance, not a claim that an ordinary old npx install works today or that every historical desktop release is supported. See the exact feature and distribution boundaries in [Manual acceptance](docs/MANUAL-ACCEPTANCE.md). Unknown protocols show a diagnostic. Physical iPhone over cellular/tunnel and Android acceptance remains outstanding.

The phone folder chooser browses computer directories through an authenticated, encrypted, read-only bridge endpoint. It uses the native desktop frontend's official picker hook, so selecting a folder does not require someone to respond to a computer-side dialog. Cancelling creates no workspace. Directory requests show a retry action after a bounded wait.

Phone compatibility patches are selected by browser capabilities rather than user-agent brand. A missing `Promise.withResolvers` is patched before the DSH frontend initializes. This design does not establish Android support: protocol fixtures and compiled frontend tests are not substitutes for real-device acceptance. To check the actual installed frontend's initialization in isolation, run `node scripts/test-dsh-workspace-browser.js --live-frontend`; this reads static assets only and does not open sessions or run tasks.

## Codex phone view

The Codex phone interface was operated at 390 × 844 against the real Codex 0.159.0 runtime. Actual replies were received using GPT-6 Astra, GPT-6 Sol, and GPT-6.1 Sol. A real question was answered, and a one-time file-read approval continued successfully. Model availability still depends on the account and installed runtime. This preview does not establish compatibility with every Codex release. The conversation list loads older pages on request; searching covers all conversation titles returned by Codex, while preview-text matching covers only conversations already loaded on the phone. A new conversation asks for a computer project folder, including a manually entered full path when it is absent from recent folders.

Conversation actions include in-page rename and archive confirmation, plus a separate attachment picker. Draft text and attachments stay with their own conversation. Model and reasoning-effort choices also stay with the conversation, and changing models resets an incompatible effort choice to that model's default. The composer labels a running-task queue action separately from sending a new turn after a task ends.

Opening or reading a Codex conversation on the phone does not take its writer lock. If desktop Codex owns that conversation, the phone can view it and save a request on the computer, but **the saved request has not reached Codex**. Finishing the desktop task alone does not send it: the bridge must later gain the writer and the previous turn must finish normally. After connecting, explicitly choose **Send saved messages**; connecting alone never sends them. The phone offers a safer way to work immediately: **copy the saved conversation context into a separate phone conversation**. This leaves the desktop conversation running and moves the current unsent draft and ready attachments into the copy for review; it does not send them automatically. An in-progress desktop step may not be fully copied, and concurrent edits to the same project files can conflict. The current installed Codex build's `thread/fork` behavior was checked with two isolated app-server processes, including while the source had another writer; real phone and other-version acceptance remains outstanding.

The phone controls distinguish **Phone can send** from **View only**. Pocket Bridge does not close desktop Codex to obtain a conversation lock: the current protocol cannot identify and verify the process holding that lock. Continue independently, or wait for the original owner to release it. Explicit handback checks that phone work is idle, cancels its subscription, and pauses its live connection. History stays visible; reconnecting requires a deliberate action. In the real Codex 0.159.0 test, another app-server could acquire the writer after approximately one minute while the phone page remained open. This delay is runtime-specific, and an unsubscribe response alone is not proof of immediate availability. See [Session control](docs/CODEX_SESSION_CONTROL.md).

## Dot access

The Codex phone menu includes **Dot · Official access guide**. It explains the official ChatGPT app route and links to the official instructions. Dot is a separate cloud service; this bridge does not provide Dot messaging, activity, or approval controls. OpenAI's current [Dot channel documentation](https://learn.chatgpt.com/docs/dots/channels) says mobile access depends on the supporting official app update and that mobile web is not supported. This guide is not a claim that Dot has been integrated or tested inside Pocket Bridge.

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

The #k= fragment is normally not sent in an HTTP request. It helps prove possession of a separate key, but it is **not** a guarantee against an intermediary that actively changes the first page or redirects the browser. The bridge-owned DSH phone view encrypts its protected content requests and replies; the explicit original DSH view still forwards some API/history replies as plaintext through the TLS-terminating relay. Covered Codex channels use application-layer encryption, and the updated file view encrypts local file paths inside request bodies. URL paths, cookies, timing, sizes and the first page remain visible to Cloudflare. **Do not assume all traffic is end-to-end encrypted or invisible to the tunnel provider.** See [Security](SECURITY.md) for the detailed threat model.

Optional notifications may contact web-push services, ntfy, or Bark. Optional balance checks can contact DeepSeek. Network-route detection may contact public-IP lookup services. The local console page itself does not load third-party assets. Do not rely on notifications to recover from a changed tunnel address.

Codex can hold an exclusive writer lock for a conversation. The phone may be able to observe a running task while the original owner retains control. A separate phone continuation does not merge future messages back into the original. Desktop termination is disabled when the writer owner cannot be verified. The Codex WebSocket app-server interface is experimental and can change with Codex releases; DeepSeek Harness updates can also affect compatibility.

Handing back phone control is a separate action and does not close desktop Codex. Closing a browser tab is not an instant handback: Bridge has disconnect cleanup, and Codex can retain an idle writer for an additional unload grace period. Explicit handback requests unsubscribe immediately and pauses reconnection, but does not bypass that runtime delay. Completion of unsubscribe and availability of the writer to another client are separate states. Pocket Bridge applies a detected system proxy to the Codex service it launches, without automatically changing Windows user-wide proxy variables. The optional desktop-proxy troubleshooting action **does** change those user-wide variables and may affect other newly opened applications; read its warning before using it.

## Maintenance and disclosure

Installing a newer Windows package over an existing installation retains local configuration, keys, logs, uploads, and TLS data. Uninstalling also leaves those private files in place by default so they are not destroyed accidentally. Remove them manually only after confirming that you no longer need them.

Pocket Bridge is independent of DeepSeek, OpenAI, and Cloudflare and is not endorsed by them. Product names are used only to identify compatible software. See [Third-party notices](THIRD-PARTY-NOTICES.md) for bundled-component licenses, [Security](SECURITY.md) for disclosure instructions, and [LICENSE](LICENSE) for this project's MIT license.
