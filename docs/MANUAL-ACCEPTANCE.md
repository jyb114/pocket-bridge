# Manual acceptance — 1.0.0-preview.6

Updated 2026-10-01. This record separates actual local interaction, isolated fixtures, the marked preview.6 package smoke and earlier release evidence. A code review, adapter fixture or running service is not an end-to-end pass.

All new workspaces and prepared runtime copies are on D:. Private addresses, credentials, conversation identifiers, personal notification destinations and private evidence artifacts are excluded from this public record.

## Current test conditions

- Official desktop product **26.928.31416**, Windows package **26.928.3736.0**, Codex CLI **0.159.2**.
- Actual phone-layout browser operation at 390 pixels; Dot reading also at 320 pixels. These are local desktop browser sessions connected to real target processes.
- Four real published npm DSH packages installed in disposable local homes. DSH RPC and successful model responses were not mocked.
- The official updater reports a restart-required update: staged package **26.928.4866.0**, product **26.928.40906**. The update has not been applied or accepted as a running baseline.
- Physical iPhone/Android, cellular access and Cloudflare tunnel acceptance are pending. Browser width does not reproduce physical-device behavior.

## Current Codex acceptance

| Workflow | Result | Actual evidence and limit |
| --- | --- | --- |
| Send to another conversation in the same project through desktop Codex | Passed | Exact conversation UUID and canonical project directory verified; actual delivery and completed assistant reply. |
| Send while another project is open | Passed | Correct target verified, delivery and completed assistant reply. |
| Send with the official desktop window minimized | Passed | Correct target opened and verified, delivery and completed assistant reply. |
| Start in ChatGPT/Your dot and send to the requested Codex conversation | Passed | A controlled test recorded that starting view; correct target, delivery and completed reply followed. |
| Refuse to overwrite an existing desktop draft | Passed | The actual refusal preserved the existing drafts. It did not close the desktop app or take its writer. |
| Outgoing-draft guard reruns | Partial | Noncurrent, different-project, minimized and blank Your dot cases passed. Cross-source drafts were refused and preserved. A same-source rerun was interrupted by concurrent desktop automation and remains pending. |
| Read-only phone UI interactions | Passed, bounded | 19 actual interactions passed, including page reloads with typed multiline drafts and remembered sending mode. A separate 98-check UI fixture covered exact draft protection, denied storage and pending-send races. Restored text was viewed at 320 and 390 pixels. This is not a pass for every live button, long history or device. |
| Busy-task immediate execution, interruption and ambiguous delivery | Pending | Queue acceptance is not execution; uncertain results must not trigger automatic resend. |
| Native relay attachments, approvals and questions | Unsupported by this route | Experimental desktop relay supports text and uses the desktop model/mode. Those controls remain on the computer. Earlier app-server results below are a different route and baseline. |

The corrected receipt matcher preserves real whitespace and reserves overlapping queued text across restarts. Its extra final-LF allowance is bounded to the tested official package family and version. The 32 isolated relay scenarios passed; accepted native delivery/reply cases provide separate actual evidence. They do not certify future versions or the pending official app update.

## Current npm DSH acceptance

| Published npm runtime | Actual passed operations | Limits |
| --- | --- | --- |
| **0.1.0-rc.8** | Project creation, two conversations, actual file download and a Bridge-staged legacy image receipt; 10 bounded checks. | A valid API key was unavailable, so model replies were not accepted. Staging an image is not model delivery. Reasoning, choices and tool approval round trips remain unverified. |
| **0.1.1-rc.2** | The same bounded project, conversation, download and staged-image operations; 10 checks. | The same unavailable valid API key and model/approval limits apply. |
| **0.1.7-rc.2** | Project creation, two conversations, actual model reply, download, upstream image receipt and image message; 12 checks. | The visible DeepSeek Account provider was selected; the default API-key provider had no key. Questions and tool approval round trips remain unaccepted. |
| **0.2.0-rc.2 CLI web** | The same operations plus an actual displayed question and answer; 14 checks. | Account provider selected. A tool approval card was displayed in a separate experiment, but allow/reject was not operated. A displayed card is not approval completion. |

The older prepared installations used compatible Cordis and matching DSH dependency pins. This is not a certification of today's fresh unmodified old-version npx install, every historical desktop wrapper or complete model compatibility. The exact **0.2.0-rc.2 CLI web** fallback was admitted only after its authenticated events and workspace baseline were verified. No uninspected desktop wrapper or future version is admitted by its version label. Generic text-file upload is unsupported by the inspected old image wire. The original lost-laptop desktop wrapper is unidentified and untested.

One discovery GET retry is limited to freshly OS-verified DSH process-owned ports and transient transport failure. Actual negative HTTP regressions retain 401/403 rejection even with truncated bodies. This change does not replay project, conversation, message or authorization writes. These security tests do not replace actual model acceptance.

## Current Dot acceptance

| Workflow | Result | Actual evidence and limit |
| --- | --- | --- |
| Native Your dot Connect and Refresh | Passed, bounded | 12 actual product checks at 390 and 320 pixels, including two native transcript reads returned through encrypted content routes. The durable conversation identity was verified. Only recent loaded message rows are read. |
| Strict native draft protection | Passed, bounded | Four actual native draft cases passed. They are draft safety checks, not delivery acceptance. |
| Dot private storage provider | Passed, bounded | A real isolated Windows test passed current-user DPAPI protection, current-user ACL validation, opening and reopening of the independently keyed store. Steady status reads required no native calls. A separate owned ACL-only change was refused despite unchanged encrypted bytes; restoring the ACL did not silently reactivate the failed store. This accepts those tested provider operations, not native Send or production deployment. |
| Send from the phone to native Dot | Pending and disabled | Source protection is integrated, but native Send acceptance has not completed. The production sender remains disabled. |
| Full cloud history, attachments, calls, approvals, activity and hidden reasoning | Unsupported by this route | These remain in the official application. Reading visible recent text does not provide all Dot functions. |
| Dot local computer execution | Blocked | Real Get-Location on the tested Windows 10 PC still fails during drive-root pin setup. A connected/authorized indicator and a pending update are not successful local reading. |

Bridge did not replace the packaged sandbox service, change its authorization state or lower isolation. The official fix and the required supported desktop update are documented in [Desktop relay acceptance](desktop-relay-experimental.md). Native conversation reading does not repair that local executor. The independent MCP inbox prototype has isolated protocol checks but no accepted real Dot subscription/reply workflow.

## Current security and packaging gates

| Gate | Current evidence and limit |
| --- | --- |
| Protected remote content | Actual HTTP negative regressions fail closed for missing, short or unreadable keys. Native routes require gateway authentication, device proof and encrypted requests/replies. A plaintext response cannot forge the browser's successful-decryption marker. |
| Tunnel threat boundary | With trusted original pages/scripts, a passive relay sees ciphertext on covered routes. Cloudflare terminates TLS and still sees URL paths, cookies and metadata. An active relay replacing the initial page is outside that protection. Classic DSH and cloud MCP have additional plaintext limits. |
| Local content storage | The experimental Dot journal uses an independent DPAPI-protected key and AES-256-GCM with current-user ACLs; its real isolated provider open/reopen test passed. Codex journals and saved-message queues may still contain plaintext. This is not a claim that all local content is encrypted at rest. |
| Current isolated CI | Isolated CI completed with no failures or whole-check skips; six separate live segments were not run. Further sender enablement or source changes require fresh applicable checks before release. Actual native/browser evidence is separate. |
| Controlled stop and restart | 27 isolated lifecycle checks and 12 scoped reload checks passed. Native admission stops before child and receipt drain; cleanup failure does not force an exit. Reload verifies the installation, exact process and boot and reports scheduled-only. The console's 31 isolated checks distinguish a new boot from the old listener. Actual production stop/restart and tray responsiveness remain unaccepted. |
| Daemon and tray stop ownership | 22 isolated daemon/provider checks and 56 PowerShell tray checks passed. Delayed managed startups are fenced by stop intent and a per-install operation lease. Tray completion waits for the held original process, the lease and fresh ownership checks; a verified already-stopped installation can quit without a false failure. Interrupted or unverified leases are not reclaimed by age or PID alone. These tests use synthetic processes and network responses, not actual tray operation. |
| Installer source contracts | 10 isolated checks passed for English-only UI, existing per-user InstallLocation, explicit /D priority, test-marker isolation, safe uninstall and required runtime-helper closure. These do not execute or accept a compiled installer. |
| Privacy exclusion | Public tracked/index source, repository history and the unpacked compiled installer payload were compared against 34 known relevant current production-private values without printing them. No private-value matches or forbidden private paths were found; bundled runtime binaries were separately hash-verified. Unknown historical credentials and image OCR are outside this comparison. |
| Compiled package install, reinstall and uninstall | Passed, bounded. A fresh D-drive directory was marked before silent installation. Every installed allowlisted source file matched the final source; bundled Node ran and isolated first-run generated local keys with an explicit nonexistent DSH credential file. Reinstall and uninstall preserved private configuration, keys and ten retention sentinels byte for byte. Shared shortcuts and registration were unchanged. No gateway, user backend, tray or native UI was started. Normal interactive destination selection and live production startup remain unaccepted. |
| Desktop shortcut installation scope | Isolated fixtures verify the shortcut's own installation identity, advertised port and stable gateway boot/process. This is not an actual production shortcut launch. |
| Matching source, installer, notes and checksums | Preview.6 uses one source version and matching English release notes. Release automation checks CI before building its Windows package and publishes installer/source checksums; publication is verified separately after the workflow finishes. |

Unknown obsolete program files are not deleted during upgrade. Private configuration and data must be retained. See [SECURITY.md](../SECURITY.md) for the full transport and trust boundary.

## Historical preview.4 and preview.5 observations

The following is the earlier acceptance record, retained as historical evidence. Its 401 failures, download timeouts, guide-only Dot state and older Codex runtime were the results of those earlier attempts. The current matrices above supersede those statements where later actual testing succeeded; they do not silently turn earlier failures into passes.

Status: **preview.5 follow-up with explicit limits**. Updated 2026-10-01. Preview.4 observations below remain historical evidence for the retained features; they were not all repeated for this follow-up. This record is based on actual browser interaction with locally running target applications, except where an entry explicitly describes an isolated HTTP or automated check. Code inspection, schemas, and mocked tests do not count as successful end-to-end use.

### Test conditions

- Windows test PC; all new test workspaces and runtime copies are on D:.
- Codex protocol executable: 0.159.0.
- Browser viewport: 390 × 844 for the hands-on Codex checks below.
- Real local npm DSH packages: 0.1.0-rc.8, 0.1.1-rc.2, 0.1.7-rc.2, and 0.2.0-rc.2.
- Separate test runtime directories and ports preserve the user's active work. A separate real Codex app-server was used to hold the source writer during the mobile-copy test.
- This record is not acceptance on physical iOS/Android devices, native mobile apps, cellular networks, or a temporary public tunnel.

Credentials, connection secrets, private addresses, and account identifiers are deliberately absent from this public record. A response marker below is ordinary test content.

### Result definitions

| Result | Meaning |
| --- | --- |
| Passed | The stated action was operated and its stated result was observed. |
| Partial | Some steps worked, but the full workflow did not complete successfully. |
| Pending | The required interaction or result has not yet been verified. |
| Unsupported | The tested adapter currently has no supported implementation for that operation. |
| Blocked | An external requirement prevented completion; this is not a pass. |

### Codex: real mobile-layout interaction

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

### DSH: actual npm runtime use

| Runtime | Setup/start | Project creation | New conversation | Send and receive a model reply | History/tool activity | Files | Approvals/questions |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0.1.0-rc.8 | Passed with dependency pins | Passed | Passed | Partial / blocked by upstream authentication | Failure history loaded; successful turn pending | Browse/read/text preview passed; image staged and removed; non-image correctly rejected; OS save pending | Legacy pending interface connected; real model-triggered acceptance blocked |
| 0.1.1-rc.2 | Passed with dependency pins | Passed | Passed | Partial / blocked by upstream authentication | Failure history loaded; successful turn pending | Browse/read/text preview passed; image staged and removed; OS save pending | Legacy pending interface connected; real model-triggered acceptance blocked |
| 0.1.7-rc.2 | Passed | Passed | Passed | Partial / blocked by upstream authentication | Failure history loaded; successful turn pending | Real chooser upload and removal passed; browse/read/text preview passed; OS save pending | Pending |
| 0.2.0-rc.2 | Passed with experimental local adapter admission | Passed | Passed | Partial / blocked by upstream authentication | Failure history loaded; successful turn pending | Browse/read/text preview passed; file staged and removed; OS save pending | Pending |

#### 0.1.0-rc.8 observations

The tester used the phone interface to create a real D: project and a new conversation. Two candidate credential configurations were tried; both sends reached the model service and returned `AUTH401`. The revised UI displayed the upstream failures instead of leaving an unexplained empty conversation. There was no accepted model reply, so this is not a send/receive pass.

The tester browsed workspace files, read a disposable text file in the safe inline preview, and obtained a download link. The in-app browser's download tool timed out; operating-system save completion was not observed. A generated download link is only a partial result. A PNG image was selected through the real chooser, staged, and removed without sending it to a model. Selecting an ordinary text attachment produced an explicit image-only limitation. Generic file upload remains unsupported in the legacy adapter.

Legacy approval/question support now uses the real runtime's event transport and response interface. Read-only pending-interface checks returned successful empty lists, including after runtime-cache expiry. No candidate model credential was accepted, so no model-triggered approval or question was answered end to end on these npm runtimes. Simulated-event regressions do not change that limitation. A transient 503 banner was observed during manual use; follow-up read-only checks did not reproduce it, and runtime discovery after cache expiry took approximately five seconds.

#### Version and installation limits

Old npm packages needed the Cordis dependency family pinned to compatible published minimum versions. This setup is a deliberately prepared test installation; it does not establish that a fresh unmodified npx install of the old version succeeds today. The npm package versions are also not proof of compatibility with an exact historical desktop installation.

The 0.1.7-rc.2 npm runtime must be tested in its own right. Historical hands-on results for a 0.1.7-rc.2 desktop app do not certify the npm web distribution. Each runtime still requires actual project/conversation/send/file/approval interactions before broader support claims can be added.

The 0.2.0-rc.2 test copy explicitly admitted that exact version as an experimental remote-mux adapter. It was operated locally for project creation, a new conversation, a real rejected model request, and file preview. This does not establish shipping support for every 0.2 build or an unmodified default installation.

### Dot: guide only

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

### Security and release acceptance

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

### Before updating the draft results

Replace Pending with Passed only after the exact workflow was operated and its result observed. Record the actual runtime version and the tested distribution. Keep upstream authentication failures, download-tool timeouts, unsupported capabilities, and device/network coverage visible. Final packaging checks must be rerun for this candidate; earlier preview results are historical, not preview.5 evidence.
