# Changelog

## 1.0.0-preview.5 — Windows preview

- Fixed a Codex phone flow where saving an instruction and then connecting through the ordinary connection control removed the only action for sending the saved instruction. Saved requests remain held until the user explicitly chooses Send saved messages.
- Added activation progress/error feedback and guarded repeated clicks, concurrent sending, and handback. The queue status response exposes only the confirmation boolean needed to distinguish saved requests from already-enabled ones.
- Kept the existing DSH adapters, Dot official-access guide, security limits, and version support boundaries. Dot messaging is still unavailable in Bridge; old/npm DSH successful model turns and physical-phone/tunnel acceptance remain unverified.

## 1.0.0-preview.4 — Windows preview

- Operated the Codex phone interface at 390 × 844 against the real Codex 0.159.0 runtime. Received GPT-6 Astra, GPT-6 Sol, and GPT-6.1 Sol replies. Continued a separate copy while the source writer stayed held; answered a real choice question and approved a real one-time read of an uploaded file.
- Removed global Codex termination from phone controls. Explicit handback unsubscribes on the owning connection and pauses reconnection. A controlled test kept the page open and another app-server acquired the same writer after the observed approximately one-minute runtime grace period. Fixed automatic idle release accidentally resuming the writer from a stale loaded-thread list.
- Clarified saved versus sent instructions, added bounded progress/error feedback, and cleared stale saved-state feedback after server-confirmed removal. Save, cancel, and explicit delivery with a real model reply were operated. Desktop task completion alone does not send a saved instruction.
- Guarded history-observation results by connection and operation identity, so stale failures cannot close a replacement socket or overwrite a current send. A separate long-running connection failure recovered after the isolated test gateway reconnected; its root cause remains unverified.
- Improved in-page conversation menus, attachment labels, duplicate-message handling, and one-time approval controls. Restricted file-read scope and blocked credential paths, link escapes, hard links, and alternate data streams. SVG/HTML/XML/script documents use safe text/attachment responses and file cards; raster image previews remain available.
- Isolated Bridge authentication cookies by instance and supported legacy-cookie migration and stale-session recovery from a valid connection link.
- Invalidated cached DSH runtime/protocol identity when the service at a fixed port changes, preventing capability results from the previous runtime from being reused.
- Exercised project/conversation creation, real rejected model requests, failure history, and safe text-file preview against four actual npm DSH runtimes. Legacy image staging/removal and modern file staging/removal were operated. Successful model replies and model-triggered approvals/questions remain blocked by upstream 401; operating-system download completion is unverified.
- Added runtime-bound legacy pending-request and image-receipt helpers with encrypted remote routes. Generic old-protocol file upload remains unsupported. Old npm setup needed compatible Cordis pins; 0.2.0-rc.2 used an experimental exact-version admission in the test copy. These partial checks do not establish universal or historical desktop support.
- Added a Dot official-access guide in the Codex menu. It describes the supported official mobile app route; Bridge has no established Dot cloud conversation, activity, or approval interface.
- Added and bundled English compatibility, session-control, security, and release documentation. Physical iPhone/Android and cellular/tunnel acceptance remain outstanding. See [Manual acceptance](docs/MANUAL-ACCEPTANCE.md) for final checks and limits.

## 1.0.0-preview.3 — mobile DSH and Codex update

- Added a small bridge-owned DSH phone interface for the DSH 0.1.7-rc.2 desktop build exercised on the test PC. It avoids the official plugin bundle on mobile tunnels and keeps a familiar project, conversation and composer layout. Other desktop builds, npm Web, and older DSH protocols were not operated end to end and are not claimed as supported by this preview.
- Added project and conversation creation, paged history, live replies, reasoning and tool records, workspace browsing, upload/download, and approval/question controls to the tested desktop phone view. Fixed a new-conversation race and unstable fallback numbering observed in live mobile-sized browser use.
- Operated the Codex phone view in a local mobile-sized browser and improved per-conversation drafts, attachments, pending-question state, writer-lock/status guidance, narrow-screen layout, and compact activity cards. New conversations require an explicit computer project folder, with a full-path option beyond recent folders.
- Added older-conversation paging and title search across the Codex store; preview text is searched only in already loaded conversations. Replaced browser-native rename and archive dialogs with in-page controls, separated conversation creation from the attachment picker, kept model/effort choices per conversation, and made the composer distinguish a queued running-task message from a new turn after completion. Compatibility with Codex releases other than the installed build was not exercised.
- Made Codex phone viewing read-only until a send action needs the writer. When desktop Codex owns a conversation, the phone can fork saved context into a separate conversation without stopping desktop Codex; the unsent draft and ready attachments move to the copy for review. The source writer stays held by desktop. Saved messages now explicitly state they have not been delivered and that desktop task completion alone will not send them. Emergency takeover is behind an advanced control because it closes the whole desktop Codex app. Idle phone writer holds return after about 30 seconds, including when the user leaves a running phone task to finish elsewhere in the interface.
- Required encrypted request bodies for protected DSH writes over a tunnel, added encrypted-body Codex file requests so updated clients do not expose local file paths in URL queries, and blocked legacy path-bearing GET downloads through a relay. The explicit original DSH view still has plaintext API/history responses; Cloudflare can see metadata and the first page. This is not a universal end-to-end encryption claim.
- Disabled the unsafe ngrok fallback and made public Host and forwarding headers trigger the remote security boundary even when the proxy connects over loopback. Arbitrary reverse proxies that erase those signals are not supported.
- Hardened phone script updating, reconnect and cache recovery. The source passed isolated CI and a strict secret scan. Current desktop DSH and local mobile-sized browser checks do not replace acceptance on the user's iPhone over 5G or on Android.

## 1.0.0-preview.2 — Windows preview

- Prepared a Windows x64 installer for the local gateway, with bundled Node.js and cloudflared. The installer is unsigned; Windows may display a reputation warning.
- Added first-run generation of local access and encryption secrets. DSH and Codex themselves are not included and must be installed and configured separately on the computer.
- Added phone-browser access, a local connection option, an optional temporary Cloudflare tunnel, device controls, and Codex session viewing and interaction.
- Improved the computer console's pairing-code display and connection guidance. A pairing code is not a substitute for the complete connection URL.
- Added a choice between queuing a Codex instruction and sending it into a running turn. If the turn cannot be confirmed, the instruction is saved to the queue only after the save succeeds.
- Added separate controls for releasing a phone-held Codex conversation and taking over a desktop-held one; the desktop action can interrupt work and is marked as hazardous.
- Added automatic phone-side handback after all Codex phone connections remain closed for about 60 seconds. This is not an instantaneous page-close operation.
- Made Codex voice recognition follow the selected interface language and hid runtime child-process console windows on Windows.
- Kept automatic proxy configuration scoped to the Pocket Bridge-managed Codex process. Changing Windows user-wide proxy variables remains an explicit, warned troubleshooting action.
- Added isolated source-install and packaging checks. Passing checks does not guarantee compatibility with every DSH/Codex version, phone, network, or notification provider.

This preview has **no Linux or macOS installer**. Temporary tunnel addresses can change or become unavailable; notifications may not arrive. Application-layer encryption covers only the channels described in [SECURITY.md](SECURITY.md). The project is independent of DeepSeek, OpenAI, and Cloudflare.
