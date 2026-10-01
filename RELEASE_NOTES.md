# Pocket Bridge v1.0.0-preview.5 — Windows preview

Pocket Bridge is a free, independent, open-source gateway for using DeepSeek Harness (DSH) or OpenAI Codex on your own Windows PC from a phone browser. Keep the PC on and configure each target separately. The installer bundles Node.js and cloudflared, but does not include DSH, Codex, accounts, subscriptions, or model access.

## Fix in preview.5

- Restore an explicit **Send saved messages** action after the ordinary **Connect this conversation** action. Previously, connecting could hide the saved-message sending control while those messages still required confirmation. Connecting alone still does not send them.
- Actually reproduced the failure and operated the corrected flow against Codex 0.159.0 at a 390 × 844 browser viewport. Explicit sending returned the real reply `saved-connect-ok` and removed the delivered queue card. This was not a physical-phone or tunnel test.
- Show progress and errors for that explicit action, prevent duplicate activation clicks, and keep paused or already-sending messages from being presented as ready to send again.
- This is a focused follow-up to preview.4. The compatibility and unfinished acceptance boundaries below remain in place; Dot integration and full old/npm DSH compatibility are not claimed.

## Retained preview.4 features

- Improved Codex new-conversation startup, first-message delivery, model selection, and task-state feedback through actual operation of the phone interface against Codex 0.159.0. Real replies were received with GPT-6 Astra, GPT-6 Sol, and GPT-6.1 Sol.
- Separated viewing from sending. If the desktop owns the original conversation, the phone can continue its saved context in an independent conversation. This was exercised with a real source writer held by another app-server, without closing it.
- Removed global desktop termination from phone lock controls. Explicit handback checks for unfinished phone work, unsubscribes on the owning connection, and pauses automatic reconnection. In a controlled test, the page stayed open and the computer-side instance acquired the same conversation after the runtime's approximately one-minute idle grace period. Immediate lock release is not promised.
- Made saved instructions visibly different from sent instructions. Save has progress/error feedback; cancel removes the pending entry and its stale confirmation. Desktop task completion does not automatically send a saved instruction.
- Prevent stale history-observation results from closing a newer Codex connection or overwriting an explicit connect/send operation. A separate long-running test connection failure recovered after the test gateway reconnected; its root cause was not established, and transport stability is not certified.
- Improved in-page rename/archive controls, readable attachment labels, duplicate-message handling, and one-time approval controls. A real file upload, one-time read approval, correct file content, and a real choice question were operated successfully.
- Added safe inline text-file previews to the DSH phone file browser. Legacy npm image attachment staging and pending-request transport are now implemented with runtime/conversation binding and bounded receipts. Generic file upload remains unavailable on the old legacy protocol.
- Isolated authentication cookies by Bridge instance and recovered stale sessions through valid connection links. Revalidate DSH identity when a different runtime reuses the same port.
- Restricted Codex file reads to verified roots and rejected credential files, directory-link escapes, multiple hard links, and Windows alternate data streams. Active documents such as SVG/HTML are returned as safe text/attachments rather than executable full-image views.
- Added an English Dot official-access guide and bundled the compatibility, session-control, security, and release documentation. Bridge does not provide a Dot messaging client.

## Actual compatibility scope

| Target | Observed result | Limit |
| --- | --- | --- |
| DSH 0.1.7-rc.2 desktop build on the test PC | This is the desktop build exercised for the bridge-owned phone interface. | Other desktop releases are unverified. This is not a promise of universal version compatibility. |
| Codex 0.159.0 | Real first replies, three model choices, independent continuation, a choice question, upload/read approval, rename, saved-pending/cancel, and delayed handback were operated. | Other Codex releases and model entitlements are unverified. OS download completion remains unverified. |
| npm DSH 0.1.0-rc.8 and 0.1.1-rc.2 | Real local project and conversation creation, rejected model requests, failure history, file preview, and image staging/removal. | Model requests returned 401. Successful replies, reasoning, and model-triggered approvals/questions were not completed. Compatible Cordis dependency pins were needed. |
| npm DSH 0.1.7-rc.2 | Real project and conversation creation, rejected model request, history, file preview, and file staging/removal. | Successful model turns and model-triggered requests remain unverified because of 401. |
| npm DSH 0.2.0-rc.2 | The same partial workflows were operated with an experimental exact-version adapter admission in the local test copy; manual reconnect restored the page. | This is not a shipping support claim for every 0.2 build or an unmodified default installation. Successful model turns remain unverified. |
| Dot | The English guide was opened at a mobile viewport and returned to the authenticated Codex page. | No Bridge Dot conversation, activity, or approval integration is available. Official app access depends on its update and account rollout. |

These were real target processes operated through a **390 × 844 desktop browser viewport**, not simulated target responses. This does not replace acceptance on a physical iPhone over cellular/tunnel or Android; those checks remain outstanding. Generated download links do not establish that a phone saved the file. The old npm setup does not prove that today's unmodified old-version npx install works out of the box, or reproduce an exact historical desktop installation. **Old/npm DSH is partially exercised, not fully supported.** See [Manual acceptance](https://github.com/jyb114/pocket-bridge/blob/v1.0.0-preview.5/docs/MANUAL-ACCEPTANCE.md).

## Security and transport

Cloudflare terminates tunnel TLS and can see paths, cookies, timing, sizes, and the initial page. The protected Bridge content channels use application-layer encryption as described in [SECURITY.md](https://github.com/jyb114/pocket-bridge/blob/v1.0.0-preview.5/SECURITY.md), including the new legacy helper routes. Original DSH views retain additional plaintext-response limits. An active relay can alter the first page; this is not an unconditional end-to-end encryption guarantee. Temporary tunnel addresses can change or become unavailable.

The Dot guide uses official links with referrer/opener isolation; it does not copy desktop login cookies. Personal notification addresses, credentials, runtime data, and private test logs are excluded from the release payload.

## Release checks

The preview.5 candidate passed 94 isolated checks with zero failures; six live segments are explicitly excluded. The publication workflow rebuilds and smoke-tests the installer from the final commit. Evidence boundaries are recorded in [Manual acceptance](https://github.com/jyb114/pocket-bridge/blob/v1.0.0-preview.5/docs/MANUAL-ACCEPTANCE.md). The Windows installer is unsigned. Verify downloaded assets against the release's SHA256SUMS.txt. Windows x64 is the only packaged platform.

Pocket Bridge is not affiliated with or endorsed by DeepSeek, OpenAI, or Cloudflare.
