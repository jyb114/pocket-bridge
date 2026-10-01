# Manual acceptance — v1.0.0-preview.5 candidate

Status: **preview.5 follow-up with explicit limits**. Updated 2026-10-01. Preview.4 observations below remain historical evidence for the retained features; they were not all repeated for this follow-up. This record is based on actual browser interaction with locally running target applications, except where an entry explicitly describes an isolated HTTP or automated check. Code inspection, schemas, and mocked tests do not count as successful end-to-end use.

## Test conditions

- Windows test PC; all new test workspaces and runtime copies are on D:.
- Codex protocol executable: 0.159.0.
- Browser viewport: 390 × 844 for the hands-on Codex checks below.
- Real local npm DSH packages: 0.1.0-rc.8, 0.1.1-rc.2, 0.1.7-rc.2, and 0.2.0-rc.2.
- Separate test runtime directories and ports preserve the user's active work. A separate real Codex app-server was used to hold the source writer during the mobile-copy test.
- This record is not acceptance on physical iOS/Android devices, native mobile apps, cellular networks, or a temporary public tunnel.

Credentials, connection secrets, private addresses, and account identifiers are deliberately absent from this public record. A response marker below is ordinary test content.

## Result definitions

| Result | Meaning |
| --- | --- |
| Passed | The stated action was operated and its stated result was observed. |
| Partial | Some steps worked, but the full workflow did not complete successfully. |
| Pending | The required interaction or result has not yet been verified. |
| Unsupported | The tested adapter currently has no supported implementation for that operation. |
| Blocked | An external requirement prevented completion; this is not a pass. |

## Codex: real mobile-layout interaction

| ID | Workflow | Result | Observed evidence and limit |
| --- | --- | --- | --- |
| CX-01 | Choose a D: project, create a conversation, choose GPT-6 Astra, send the first instruction | Passed | Real response `codex-mobile-ok` appeared in the phone interface. |
| CX-02 | Create a conversation using GPT-6 Sol and send the first instruction | Passed | Real response `sol-mobile-ok` appeared. This confirms the tested runtime/account could use this model during this run. |
| CX-03 | Continue from a conversation whose writer is held by a separate real app-server | Passed | The source writer stayed held. The phone created a separate copy and received `mobile-fork-ok`; it did not need to stop the source service. |
| CX-04 | Receive and answer a real request with Alpha/Beta choices | Passed | Plan mode produced a real `request_user_input`. The tester selected Beta through the phone UI, and the final response was `Use#Beta`. |
| CX-05 | Release a phone writer and regain it through a separate real app-server | Passed with runtime delay | A controlled pre-check was rejected while the phone owned the writer. The tester used in-page handback, left the page open with live updates paused, and a separate app-server resumed the exact conversation after approximately 60 seconds. Both services remained running. Earlier failures occurred inside Codex's idle unload grace period; immediate handback is not promised. |
| CX-06 | Attach a file, read its content, and complete download to the operating system | Partial | A real chooser uploaded a disposable text file; an actual approved command read it and the correct line appeared. Opening its file control was operated; OS save completion remains unverified. |
| CX-07 | Receive a real execution/file approval, answer it, and observe the task continue | Passed | A real Get-Content approval for the single uploaded file arrived in the phone UI. Approve once was selected; the command succeeded and returned the actual disposable file content. No persistent command rule was approved. |
| CX-08 | Save a queued phone instruction, then deliberately send it after writer availability | Passed with recovery limitation | A real click saved one instruction, cleared the draft, and displayed Saved, not sent with an explicit connect/send control. Deliberate delivery produced queue-final-ok. A later connection interruption preserved the next pending instruction without sending it; after the isolated test gateway reconnected, explicit retry produced queue-feedback-ok and cleared the stale saved notice. A separate pending instruction was canceled without sending. The earlier long-running connection failure's root cause was not established, so transport stability is not certified. |
| CX-09 | Inspect all menus, keyboard behavior, navigation, error recovery, and long history | Pending | Individual fixes and partial browsing do not establish a complete button-by-button acceptance. |
| CX-10 | Operate on a physical iPhone through cellular/temporary tunnel | Pending | A desktop browser viewport does not reproduce Safari device behavior or tunnel reliability. |
| CX-11 | Operate on a physical Android phone | Pending | Not operated in this acceptance run. |
| CX-12 | Select GPT-6.1 Sol and send an instruction | Passed | The tester selected the actual model and low effort controls; the real response `sol61-mobile-ok` appeared. |
| CX-13 | Rename a disposable conversation and cancel its archive confirmation | Passed | The name saved and reappeared in the list. The archive confirmation explained that it does not delete content; cancellation was operated. Archive completion and restoration remain unverified. |
| CX-14 | Save while viewing, use ordinary Connect, then explicitly send the saved request | Passed in preview.5 follow-up | The tester actually reproduced preview.4 hiding the only saved-send action after ordinary Connect. In the corrected UI, ordinary Connect left the request held and displayed Send saved messages. An explicit click showed progress, the actual Codex turn returned `saved-connect-ok`, and the queue card cleared. English language selection was operated. This used the real Codex 0.159.0 process at 390 × 844, not a simulated reply or a physical phone. |

These results are scoped to Codex 0.159.0 and the observed account/runtime. They do not certify every Codex desktop release or every model entitlement.

## DSH: actual npm runtime use

| Runtime | Setup/start | Project creation | New conversation | Send and receive a model reply | History/tool activity | Files | Approvals/questions |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0.1.0-rc.8 | Passed with dependency pins | Passed | Passed | Partial / blocked by upstream authentication | Failure history loaded; successful turn pending | Browse/read/text preview passed; image staged and removed; non-image correctly rejected; OS save pending | Legacy pending interface connected; real model-triggered acceptance blocked |
| 0.1.1-rc.2 | Passed with dependency pins | Passed | Passed | Partial / blocked by upstream authentication | Failure history loaded; successful turn pending | Browse/read/text preview passed; image staged and removed; OS save pending | Legacy pending interface connected; real model-triggered acceptance blocked |
| 0.1.7-rc.2 | Passed | Passed | Passed | Partial / blocked by upstream authentication | Failure history loaded; successful turn pending | Real chooser upload and removal passed; browse/read/text preview passed; OS save pending | Pending |
| 0.2.0-rc.2 | Passed with experimental local adapter admission | Passed | Passed | Partial / blocked by upstream authentication | Failure history loaded; successful turn pending | Browse/read/text preview passed; file staged and removed; OS save pending | Pending |

### 0.1.0-rc.8 observations

The tester used the phone interface to create a real D: project and a new conversation. Two candidate credential configurations were tried; both sends reached the model service and returned `AUTH401`. The revised UI displayed the upstream failures instead of leaving an unexplained empty conversation. There was no accepted model reply, so this is not a send/receive pass.

The tester browsed workspace files, read a disposable text file in the safe inline preview, and obtained a download link. The in-app browser's download tool timed out; operating-system save completion was not observed. A generated download link is only a partial result. A PNG image was selected through the real chooser, staged, and removed without sending it to a model. Selecting an ordinary text attachment produced an explicit image-only limitation. Generic file upload remains unsupported in the legacy adapter.

Legacy approval/question support now uses the real runtime's event transport and response interface. Read-only pending-interface checks returned successful empty lists, including after runtime-cache expiry. No candidate model credential was accepted, so no model-triggered approval or question was answered end to end on these npm runtimes. Simulated-event regressions do not change that limitation. A transient 503 banner was observed during manual use; follow-up read-only checks did not reproduce it, and runtime discovery after cache expiry took approximately five seconds.

### Version and installation limits

Old npm packages needed the Cordis dependency family pinned to compatible published minimum versions. This setup is a deliberately prepared test installation; it does not establish that a fresh unmodified npx install of the old version succeeds today. The npm package versions are also not proof of compatibility with an exact historical desktop installation.

The 0.1.7-rc.2 npm runtime must be tested in its own right. Historical hands-on results for a 0.1.7-rc.2 desktop app do not certify the npm web distribution. Each runtime still requires actual project/conversation/send/file/approval interactions before broader support claims can be added.

The 0.2.0-rc.2 test copy explicitly admitted that exact version as an experimental remote-mux adapter. It was operated locally for project creation, a new conversation, a real rejected model request, and file preview. This does not establish shipping support for every 0.2 build or an unmodified default installation.

## Dot: guide only

| Workflow | Result | Evidence and limit |
| --- | --- | --- |
| Serve the English official-access guide | Passed (isolated HTTP) | The actual isolated gateway returned `/dot-guide` as HTML with no-cache and explicit capability limits. |
| Keep Bridge session when visiting the guide and returning | Passed (isolated HTTP and script execution) | The authenticated session still opened Codex; the local encryption fragment was preserved. No secret values are recorded here. |
| Isolate external official links | Passed (isolated HTML check) | Official links use referrer and opener isolation. This is a page check, not a cloud Dot session test. |
| Open the entry and guide at the mobile viewport | Passed | The tester opened the Codex menu entry, viewed the English guide at 390 × 844, and returned to the authenticated Codex list. This does not establish Dot messaging. |
| Send/receive the user's existing cloud Dot messages in Bridge | Unsupported | No established official Dot transport is available through Bridge. |
| Mirror Dot activity or answer Dot approvals in Bridge | Unsupported | No established official activity/approval transport is available through Bridge. |
| Open the same Dot in the official phone app | Pending | Depends on the supporting app update and account rollout; requires a physical-device test. |

The guide directs users to official ChatGPT and the official setup/channel documentation. It does not forward desktop login cookies or claim to host a Dot client. OpenAI currently describes mobile web as unsupported. [Message your dot](https://learn.chatgpt.com/docs/dots/channels).

In the preview.5 follow-up, the tester opened the existing Dot guide again through the real phone menu and returned to the authenticated Codex list. No new Dot messaging capability was implemented or accepted.

## Security and release acceptance

| ID | Gate | Result |
| --- | --- | --- |
| SEC-01 | Per-instance authentication-cookie isolation, stale-cookie recovery, and legacy migration | Passed isolated HTTP/regression checks; not a security certification |
| SEC-02 | Fixed-port runtime replacement invalidates previous protocol/capability results | Passed isolated runtime-replacement checks |
| SEC-03 | Phone controls do not globally kill desktop Codex; handback acts on the owning connection | Passed targeted regressions and actual CX-05; runtime grace period applies |
| SEC-04 | Protected request, file, and streamed-content encryption boundaries match SECURITY.md | Passed relevant isolated encryption/negative checks; first-page and relay limits remain |
| SEC-05 | Codex verified-root file policy and safe active-document responses | Passed actual filesystem and HTTP tests; one Windows file-symlink test explicitly skipped after EPERM |
| REL-01 | Candidate isolated CI and relevant targeted regression checks | Preview.5: 94 isolated checks, zero failures and zero whole-check skips; six live segments explicitly excluded. The saved-send fix additionally passed 22 isolated browser/HTTP queue checks, 60 lock-UX assertions, 75 mobile-control assertions, and 10 backend queue checks. These automated checks supplement CX-14; they do not replace human acceptance. The CI workflow runs the suite on the final publication commit. |
| REL-02 | Strict secret scan and clean source package inspection | Strict tracked-source/history scan passed; final published asset inspection is separate |
| REL-03 | Installer build, install/upgrade/uninstall smoke tests, and data preservation | Historical preview.4 evidence includes isolated Windows install, first startup, same-version upgrade, actual preview.3-to-preview.4 upgrade, and uninstall/data-preservation checks. Preview.5 requires its own publication build and installer smoke results; prior tests do not certify a preview.4-to-preview.5 upgrade. |
| REL-04 | Public source, installer, notes, and asset checksums match the accepted candidate | Verify through the preview.5 release assets and publication workflow; this record does not claim physical-device acceptance |

Cloudflare can see tunnel metadata and the first page. Covered application-layer encryption does not provide an unconditional guarantee against an active relay changing that first page. Original DSH views have additional plaintext-response limits. The detailed boundary belongs in [SECURITY.md](../SECURITY.md).

## Before updating the draft results

Replace Pending with Passed only after the exact workflow was operated and its result observed. Record the actual runtime version and the tested distribution. Keep upstream authentication failures, download-tool timeouts, unsupported capabilities, and device/network coverage visible. Final packaging checks must be rerun for this candidate; earlier preview results are historical, not preview.5 evidence.
