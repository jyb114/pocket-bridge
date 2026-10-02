# Pocket Bridge

Pocket Bridge is an unofficial, free and open-source gateway for using DeepSeek Harness (DSH) or OpenAI Codex on your own Windows computer from a phone browser. Its experimental Dot view reads the real Your dot conversation in the official desktop app. The computer performs the work; Pocket Bridge does not provide AI accounts or model access.

You do not need to register for a Pocket Bridge account or install a Pocket Bridge phone app. You **do** need the software you want to access already installed and signed in on the computer:

| What you want to use on your phone | What the computer needs |
| --- | --- |
| DeepSeek Harness | The current DeepSeek Harness desktop build tested for this preview, installed and signed in |
| Codex | The current OpenAI Codex desktop installation tested for this preview, signed in |
| Both | Both of the above |
| Experimental Dot reading | The tested official ChatGPT desktop app, signed in with Your dot available |

**You do not have to install both products.** Pocket Bridge discovers and starts each available target separately. A ChatGPT website session, by itself, is not a local Codex installation. The Pocket Bridge installer includes its own Node.js runtime and cloudflared, but **does not include DeepSeek Harness, Codex, their accounts, or model access**. Those products may have separate eligibility, subscription, and usage costs. Your computer must remain on and connected to the internet while you use it remotely.

## Current status

This is **1.0.0-preview.6**, an experimental Windows preview with the tested scope and limits listed below. Use the matching preview.6 installer; earlier installers do not include these changes.

- Windows x64 is the only packaged platform. The compiled preview.6 installer passed a marked install, reinstall and uninstall on the test Windows PC, with bundled Node execution and private-data retention checks. This smoke did not start a gateway, discover user backends or operate the tray; those live startup paths remain outside this package acceptance.
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

The following published npm packages were installed locally and operated through the real Bridge phone interface in Edge/Chrome at a 390-pixel viewport. DSH RPC and model responses were not mocked.

| npm DSH version | Actual accepted operations | Limits |
| --- | --- | --- |
| `0.1.0-rc.8` and `0.1.1-rc.2` | Project creation, two conversations, file download, and a Bridge-staged legacy image receipt. | No successful model response: a valid API key was unavailable. The staged image was not sent to a model. Reasoning, questions and tool approval round trips were not accepted. |
| `0.1.7-rc.2` | Project creation, two conversations, actual model response, file download, upstream image receipt and image message. | The visible DeepSeek Account provider had to be selected. The default API-key provider had no key. Questions and tool approval round trips were not accepted. |
| `0.2.0-rc.2` | The same project, conversation, response, download and image operations, plus an actual displayed question and answer. | The account provider had to be selected. A tool approval card was displayed in a separate experiment, but allow/reject was not exercised. |

The older prepared npm installations used compatible Cordis and matching DSH dependency pins. These results do not certify today's unmodified old-version `npx` installation or every historical desktop wrapper. The newly enabled version fallback is exactly npm CLI `0.2.0-rc.2`, with its authenticated events and workspace baseline verified; a version label does not enable an uninspected desktop wrapper or future release. Generic text-file upload is not supported by the inspected old image wire. The original lost-laptop desktop wrapper has not been identified or tested. These were local mobile-sized browser tests, not physical iPhone/Android, mobile 5G or Cloudflare tunnel acceptance. See the exact current and historical evidence in [Manual acceptance](docs/MANUAL-ACCEPTANCE.md).

The phone folder chooser browses computer directories through an authenticated, encrypted, read-only bridge endpoint. It uses the native desktop frontend's official picker hook, so selecting a folder does not require someone to respond to a computer-side dialog. Cancelling creates no workspace. Directory requests show a retry action after a bounded wait.

Phone compatibility patches are selected by browser capabilities rather than user-agent brand. A missing `Promise.withResolvers` is patched before the DSH frontend initializes. This design does not establish Android support: protocol fixtures and compiled frontend tests are not substitutes for real-device acceptance. To check the actual installed frontend's initialization in isolation, run `node scripts/test-dsh-workspace-browser.js --live-frontend`; this reads static assets only and does not open sessions or run tasks.

## Codex phone view

Real read-only phone UI operation passed 19 interactions, including page reloads with the actual conversation history and typed multiline drafts. A separate 98-check UI fixture covered remembered sending mode, exact draft protection, storage failures and pending-send races. Those fixtures do not certify every live button or desktop state.

The candidate also coordinates Bridge shutdown with its native operations. A stop or restart first refuses new desktop actions, then waits for owned helpers and receipt processing. A scheduled restart is not completion: the console waits for a different gateway boot identifier. If cleanup cannot be confirmed, Bridge reports a blocked operation rather than forcing an exit. These lifecycle checks use isolated services and do not establish an actual production stop or restart.

The phone interface lists conversations, loads older pages on request, and keeps each conversation's draft, attachments, model and reasoning-effort choices separate. Bounded text drafts survive reloads within the same browser tab through session storage; attachments are not restored this way. Text is stored locally in plaintext, as described in [SECURITY.md](SECURITY.md). The explicitly chosen desktop sending mode is remembered without automatically connecting or sending. Title search covers titles returned by Codex; preview-text search covers conversations already loaded on the phone. New conversations ask for a computer project folder, with a full-path option when it is absent from recent folders.

### Sending while desktop Codex holds the conversation

The experimental **Send through desktop Codex** control sends plain text through the official computer app. Bridge verifies the exact conversation UUID and canonical project directory, opens that conversation, and uses the desktop Send button. It does not take the phone writer lock or close desktop Codex. Leave the computer free while using this mode because it operates the desktop UI and briefly uses the clipboard.

On official desktop product `26.928.31416`, Windows package `26.928.3736.0`, and Codex CLI `0.159.2`, actual local phone-to-desktop tests confirmed delivery and completed assistant replies with another conversation open in the same project, another project open, the desktop window minimized, and the app initially showing ChatGPT/Your dot before routing to the correct Codex conversation. A separate real test refused to send over an existing desktop draft and preserved the drafts. These are accepted cases on that exact baseline, not a guarantee for other app versions or every desktop state. After the outgoing-draft guard changed, controlled reruns passed for a noncurrent conversation, another project, a minimized window and a blank Your dot view. Cross-source drafts were safely refused and preserved. A same-source rerun encountered concurrent desktop automation and remains pending.

Desktop relay uses the computer's current model, reasoning effort and collaboration mode. Phone selections do not apply. Its first implementation supports text only: attachments stay in the phone draft, and desktop approvals, choices and questions still need to be handled on the computer. A message received by the desktop queue has not necessarily started executing. If delivery is uncertain, **Check previous delivery** checks the existing result; Bridge does not automatically resend it. Existing computer drafts are preserved, and unresolved conversation identity, unreadable drafts or ambiguous receipts stop the send.

An app update is staged and the official updater reports that a restart is required. The running tested version has not been replaced for this acceptance. The staged package `26.928.4866.0` is not a tested native-relay baseline; native identity, draft, send and receipt behavior need fresh acceptance after updating.

### Sending through the phone app-server

The ordinary phone connection remains available. Opening or reading a conversation does not take its writer lock. When desktop Codex owns the original conversation, the phone can save an instruction on the computer or copy saved context into a separate phone conversation. Saving alone does not deliver or execute the instruction. After gaining the writer, explicitly choose **Send saved messages**; connecting alone never sends them. A copied conversation leaves the original running, but an in-progress step may be incomplete and simultaneous edits to the same project files can conflict.

Explicit phone handback checks that phone work is idle, unsubscribes and pauses reconnection while keeping history visible. Codex can retain an idle writer during a runtime-specific grace period, so handback is not a promise of immediate desktop availability. Bridge does not close the entire desktop app based on an unverified lock owner.

Earlier real app-server tests against Codex `0.159.0` received GPT-6 Astra, GPT-6 Sol and GPT-6.1 Sol replies, answered a question, and completed a one-time file-read approval. Those results are a separate previous baseline. Model access depends on the account and runtime; they do not certify all current models or versions. See [Session control](docs/CODEX_SESSION_CONTROL.md) and [Desktop relay acceptance](docs/desktop-relay-experimental.md).

## Dot access

The experimental Dot page connects to the real **Your dot** conversation in the official desktop app. Connect and Refresh open that view on the computer, verify the same durable conversation identity, and read only recent message rows currently loaded in its conversation pane. The page shows previous messages when a refresh fails and provides a jump-to-latest control. Only materialized recent history is available; older cloud messages may be missing.

Actual local browser operation at 390- and 320-pixel viewports passed 12 connection/refresh checks, including two native transcript reads returned through encrypted content routes. Four strict native draft cases also passed. Those draft checks establish their tested safety behavior, not Dot delivery: **Dot sending is still disabled and under implementation**. Attachments, calls, approvals, activity, hidden reasoning and task controls remain in the official desktop app.

Connecting a computer does not prove Dot can run local tasks. On the tested Windows 10 installation, official Dot local execution still fails with the drive-root pin error. An official app update is staged, but a repaired running executor has not been verified. Bridge has not replaced the packaged sandbox service or reduced its isolation. The native Dot read route does not repair this official executor failure.

Keep the computer free while using the Dot page: connection and refresh use the desktop view and briefly preserve/use its clipboard. This feature is experimental, has not passed physical-phone or tunnel acceptance, and is not a claim that all Dot functionality is available remotely.

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

A passive tunnel observer sees ciphertext on the covered content routes rather than message plaintext, provided the original page and scripts are trusted. That protection does not extend to an active intermediary replacing the initial page.

The #k= fragment is normally not sent in an HTTP request. It helps prove possession of a separate key, but it is **not** a guarantee against an intermediary that actively changes the first page or redirects the browser. The bridge-owned DSH phone view encrypts its protected content requests and replies; the explicit original DSH view still forwards some API/history replies as plaintext through the TLS-terminating relay. Covered Codex channels use application-layer encryption, and the updated file view encrypts local file paths inside request bodies. URL paths, cookies, timing, sizes and the first page remain visible to Cloudflare. **Do not assume all traffic is end-to-end encrypted or invisible to the tunnel provider.** See [Security](SECURITY.md) for the detailed threat model.

Remote protected content routes fail closed when their encryption key is missing, too short or unreadable. The encrypted native desktop routes also require gateway authentication and device proof. Local journals and saved-message queues may contain plaintext submitted text on the computer; transport encryption is not encryption at rest.

Optional notifications may contact web-push services, ntfy, or Bark. Optional balance checks can contact DeepSeek. Network-route detection may contact public-IP lookup services. The local console page itself does not load third-party assets. Do not rely on notifications to recover from a changed tunnel address.

Codex can hold an exclusive writer lock for a conversation. The phone may be able to observe a running task while the original owner retains control. A separate phone continuation does not merge future messages back into the original. Desktop termination is disabled when the writer owner cannot be verified. The Codex WebSocket app-server interface is experimental and can change with Codex releases; DeepSeek Harness updates can also affect compatibility.

Handing back phone control is a separate action and does not close desktop Codex. Closing a browser tab is not an instant handback: Bridge has disconnect cleanup, and Codex can retain an idle writer for an additional unload grace period. Explicit handback requests unsubscribe immediately and pauses reconnection, but does not bypass that runtime delay. Completion of unsubscribe and availability of the writer to another client are separate states. Pocket Bridge applies a detected system proxy to the Codex service it launches, without automatically changing Windows user-wide proxy variables. The optional desktop-proxy troubleshooting action **does** change those user-wide variables and may affect other newly opened applications; read its warning before using it.

## Maintenance and disclosure

The installer uses English and remembers the existing per-user installation directory from its registered InstallLocation. A valid existing D-drive location takes priority over the fresh-install default; an explicit installer /D destination still overrides it. Ten isolated packaging contracts and the marked compiled-installer smoke passed. The marked test verified that shared shortcuts and registration stayed unchanged; it did not exercise normal interactive destination selection. The desktop shortcut now opens only a gateway with this installation's verified identity.

Installing a newer Windows package over an existing installation retains local configuration, keys, logs, uploads, and TLS data. Uninstalling also leaves those private files in place by default so they are not destroyed accidentally. An upgrade does not remove unknown obsolete program files from an earlier package. Remove private data or old files manually only after confirming that you no longer need them.

Before upgrading, stop and exit the existing Pocket Bridge service using its current tray, then run the new installer and reopen Pocket Bridge. The new shortcut requires a fresh verified gateway identity and boot; it refuses older running gateways that do not provide that proof. The installer does not stop your running service for you.

Pocket Bridge is independent of DeepSeek, OpenAI, and Cloudflare and is not endorsed by them. Product names are used only to identify compatible software. See [Third-party notices](THIRD-PARTY-NOTICES.md) for bundled-component licenses, [Security](SECURITY.md) for disclosure instructions, and [LICENSE](LICENSE) for this project's MIT license.
