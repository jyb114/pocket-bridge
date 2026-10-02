# Pocket Bridge 1.0.0-preview.6 — Windows preview

Pocket Bridge is a free, independent, open-source gateway for using DeepSeek Harness or OpenAI Codex on your own Windows computer from a phone browser. This update adds an experimental way to send text through desktop Codex while that app owns the conversation, and a native Your dot view for recent messages. Keep the computer on, signed in and free from simultaneous desktop use during native phone actions.

This is an experimental preview. Use the matching preview.6 source and Windows installer. The compatibility table below records the operated scope; it does not promise full compatibility with every DSH version, desktop state or phone network.

## What changed

Desktop relay locates the selected conversation by UUID and project directory before using the official desktop Send button. Actual tests returned completed assistant replies when another conversation or project was open, when the window was minimized, and when the app initially showed ChatGPT/Your dot. A separate real test refused to send over an existing desktop draft. After the outgoing-draft guard changed, controlled noncurrent, different-project, minimized and blank Your dot reruns passed. Cross-source drafts were safely refused and preserved; the same-source rerun encountered other desktop automation and remains pending. Bridge checks delivery without closing desktop Codex or changing the writer lock. A desktop queue receipt does not prove that execution has started, and an uncertain result is never automatically resent.

Nineteen real read-only phone UI interactions passed, including actual page reloads that preserve the chosen sending mode and typed multiline draft. A separate 98-check UI fixture covered draft protection, denied storage and pending-send races; it does not replace live interaction. Bounded text drafts use plaintext session storage within the same browser tab. Attachments are not restored. Restoring a draft or sending-mode preference never sends a message automatically.

Controlled Bridge shutdown now stops admission before waiting for owned native helpers and the complete receipt tail. The console distinguishes a scheduled restart from a new gateway process using a fresh boot identifier. Cleanup failure leaves a visible blocked state rather than forcing an exit. The local reload command verifies its installation, process and boot before requesting this coordinated restart; it does not kill a process or launch a replacement itself. These are isolated lifecycle checks, not an accepted production stop/restart.

Tray Stop now targets the verified gateway belonging to this installation. It waits for pending managed startups, checks physical process completion and refreshes tunnel ownership before cleanup. A verified already-stopped installation can quit or rotate keys without attempting another shutdown. Unknown ownership remains blocked. The 56 isolated tray checks and 22 daemon/provider checks do not certify actual tray responsiveness or a live production shutdown. The obsolete live test that assumed age-based daemon-lock takeover was replaced by the isolated operation-fence suite.

The new Dot page connects to the real Your dot desktop conversation and refreshes only recent loaded message rows. Connect and Refresh passed actual local browser tests at 390- and 320-pixel widths, with encrypted transcript responses. Four strict draft cases passed, but Dot sending is still disabled and under implementation. This does not provide full cloud history, approvals, task controls, calls or file transfer.

DSH discovery tolerates one transient transport failure on a freshly verified process-owned listener. Negative HTTP responses, including truncated authorization failures, are not retried. No project, conversation, message or approval write is replayed by this discovery change. The npm CLI 0.2.0-rc.2 fallback is limited to its inspected protocol.

The installer uses English and remembers a valid existing per-user InstallLocation, including D-drive installations. An explicit /D destination still takes priority. Marked compiled install, reinstall and uninstall checks kept shared shortcuts and registration untouched and preserved private configuration and data. Upgrading does not delete unknown obsolete program files. The desktop shortcut verifies its own installation identity before opening a gateway instead of selecting another installation's listener.

Stop and exit the existing Bridge using its current tray before upgrading, then reopen after installation. The shortcut refuses older running gateways without the new identity/boot proof. The installer does not terminate the old service.

## Actual compatibility

| Target | Accepted scope | Limits |
| --- | --- | --- |
| DSH 0.1.7-rc.2 desktop build previously tested on the PC | Bridge-owned project, conversation and file/message interface. | Other desktop wrappers are not certified. |
| Official desktop product 26.928.31416, Windows package 26.928.3736.0, Codex CLI 0.159.2 | Desktop relay delivery and completed reply with a noncurrent conversation, another project, a minimized window and an initial ChatGPT/Your dot view; a preserved-draft refusal also passed. | Text only, desktop model/mode; no native approval/question forwarding or interrupt guarantee. A staged app update has not yet passed fresh acceptance. |
| npm DSH 0.1.0-rc.8 and 0.1.1-rc.2 | Project creation, two conversations, actual download and Bridge-staged legacy image receipt. | No valid API key was available for successful model replies. No image-to-model, reasoning, choices or approval round-trip acceptance. |
| npm DSH 0.1.7-rc.2 | Project/conversation, actual reply, download, upstream image receipt and image message. | DeepSeek Account provider selected explicitly; questions and approval round trips unaccepted. |
| npm DSH 0.2.0-rc.2 CLI web | The same operations plus an actual displayed question and answer. | Account provider selected; a separately displayed approval card did not establish allow/reject completion. No other 0.2 version or desktop wrapper certified. |
| Your dot in the tested official desktop app | Connect and Refresh of bounded loaded messages; strict draft safety cases. | Dot sending disabled; official local execution still fails on the test Windows 10 PC. |

The old prepared npm installations used compatible dependency pins. These tests do not certify a fresh unmodified old-version npx installation or the original lost-laptop desktop wrapper. All new phone tests were local mobile-sized browser operation with real target processes, not physical iPhone/Android or 5G/Cloudflare tunnel acceptance.

## Privacy and security

Protected remote content routes use application-layer encryption, gateway authentication and device proof. Missing, short or unreadable content keys close those routes instead of returning plaintext. Plaintext responses cannot forge a successful decryption marker. For trusted original pages and scripts, a passive tunnel observer sees ciphertext on covered routes. An active intermediary replacing the initial page is outside that protection. Cloudflare still terminates TLS and can see URL paths, cookies, timing, sizes and the first page. The explicit original DSH frontend and separate cloud MCP prototype have additional plaintext limits. This is not a claim that all traffic is invisible to Cloudflare.

Local request journals and saved-message queues can contain plaintext submitted text. The transport protections are not encryption at rest. Personal notification destinations, private reminder content, credentials, runtime data and private test artifacts must stay out of source and installer assets.

## Validation and remaining limits

Isolated CI completed with no failures or whole-check skips; six separately classified live segments were not run. Ten installer source contracts passed. The compiled package passed marked install, reinstall and uninstall, exact installed-source comparison, bundled Node execution and isolated first-run without DSH credentials. Shared registration and shortcuts were unchanged; private configuration, keys and data were retained byte for byte. The unpacked compiled payload and public source/history passed comparison against known current private values. The package smoke did not start a gateway or user backend, and it is not acceptance of normal interactive installation, live tray/startup or a physical phone. Real Codex relay and Dot read/draft checks above remain separate evidence. Native Dot Send is disabled. The staged official desktop update has not been applied for this baseline, and the official Dot local executor pin failure has not been repaired.

Windows x64 is the only packaged platform. The installer is unsigned; verify assets against SHA256SUMS.txt from this release. The installer bundles Node.js and cloudflared, not DSH, Codex, accounts or model access.

Pocket Bridge is not affiliated with or endorsed by DeepSeek, OpenAI or Cloudflare.
