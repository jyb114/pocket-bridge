# Pocket Bridge v1.0.0-preview.3 — Windows preview

Pocket Bridge is an independent, open-source gateway for using DeepSeek Harness (DSH) or OpenAI Codex on your own Windows PC from a phone browser. The PC must stay on, and the target app must be installed and signed in separately. Pocket Bridge does not include DSH, Codex, their accounts, or model access.

## Downloads

- `PocketBridge-1.0.0-preview.3-win-x64-Setup.exe` — Windows x64 installer with bundled Node.js and cloudflared.
- `PocketBridge-v1.0.0-preview.3-source.zip` — clean source archive.

The installer is not code-signed; Windows may show an unknown-publisher warning. Compare downloads with `SHA256SUMS.txt` before installing.

## What changed

- Added a small bridge-owned DSH phone view for the desktop build tested in this preview. It avoids downloading the official plugin bundle through the tunnel. It provides a familiar project and conversation layout, project and conversation creation, history, live replies, reasoning and tool activity, workspace file operations, and approval and question controls.
- Fixed DSH conversation creation races and unstable numbering. The selected new conversation now remains selected across a refresh in local mobile-sized browser testing.
- Operated the Codex phone view in a local mobile-sized browser and improved conversation-specific drafts and attachments, pending questions, writer-lock guidance, compact task status and activity cards, image previews, and narrow-screen layout. New conversations require an explicit computer project folder; a full-path option is available when it is absent from recent folders.
- Added older-conversation paging and title search across the Codex store; preview text is searched only in conversations already loaded on the phone. Rename and archive now use in-page controls, the attachment picker distinguishes adding files from starting a conversation, model and reasoning choices stay with each conversation, and the composer distinguishes queuing during a running task from sending a new turn after completion.
- Reading a Codex conversation on the phone no longer takes its writer lock. If desktop Codex owns the original conversation, the phone can copy saved context into a separate conversation and continue without closing desktop Codex. The current unsent draft and ready attachments move to the copy for review; no message is sent automatically. Saved queue entries remain on the original and are explicitly marked as not delivered. Emergency takeover is now an advanced action because it can close the entire desktop Codex app and stop its running tasks. An idle phone writer is handed back after about 30 seconds; an active phone turn is allowed to finish first.
- Tightened protected tunnel routes: DSH prompt and upload requests cannot silently fall back to plaintext; updated Codex file requests keep local file paths inside encrypted bodies and reject unverified file responses. The tested DSH desktop protocol defaults to the bridge-owned phone view on a mobile tunnel.
- Disabled the unsafe ngrok fallback and made public Host and forwarding headers trigger the remote security checks even when a tunnel connects through loopback. Arbitrary reverse proxies that hide their public origin are not supported.
- Hardened page updating, reconnection, and cache recovery.

## Compatibility and security limits

This preview was operated with the DSH desktop **0.1.7-rc.2** installed on the test PC and the locally installed Codex desktop. Other DSH desktop builds, `npx @deepseek-ai/dsh web`, and older DSH protocols were **not operated end to end**; this release does **not claim support** for them. Package inspection and adapter fixtures are not a substitute for actual use through the phone interface. Compatibility with other Codex releases is also unverified.

Cloudflare terminates tunnel TLS and can see URL paths, cookies, timing, traffic sizes, and the initial page. The bridge-owned DSH view encrypts protected content bodies, and covered Codex channels use application-layer encryption. Explicitly opening the original DSH view can still expose some API and history responses to the tunnel provider. An active relay could change the first page or redirect the browser, so this is **not** an unconditional end-to-end encryption guarantee. Keep the complete connection URL private and read [SECURITY.md](https://github.com/jyb114/pocket-bridge/blob/main/SECURITY.md) before remote use.

Release validation passed 83 isolated CI checks, 48 release-readiness checks, a strict secret scan, and smoke tests of the rebuilt Windows installer for install, upgrade, a fresh Codex-only gateway, uninstall, and user-data preservation. The new lock flow was operated in an isolated, mobile-sized browser preview and checked against the locally installed Codex protocol with two isolated app-server processes. Local browser checks do not replace acceptance of this release on a real iPhone over 5G or on Android. The revised interfaces have not been accepted on a real phone through the temporary tunnel, and temporary TryCloudflare addresses can change or become unavailable.

Pocket Bridge is not affiliated with or endorsed by DeepSeek, OpenAI, or Cloudflare.
