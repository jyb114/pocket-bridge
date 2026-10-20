# Preview.20 compact controls acceptance

Recorded 2026-10-20. This candidate record separates actual runtime operations,
isolated browser regressions, distribution status and checks that are still
pending. A pending result is not a pass.

## Candidate scope

Model and reasoning choices share a compact card with a back action. A
successful picker choice closes after 150 ms instead of 700 ms. Goal, plan
and context-compaction controls have separate tabs; the message draft and
goal input remain separate. Plan selection and command-list reads start
when the plan tab is opened rather than when the goal panel opens.

Plan actions are serialized. Dialog disposal removes its listeners and
clears page-inert state. A completed goal or stale context cannot be used
to confirm an edit. These changes retain the existing runtime identity,
authorization, encrypted transport and mutation readback requirements.

## Actual DSH operations observed

The candidate was operated through its visible browser controls against the
actual **DSH 0.2.1-rc.2** runtime in a separate local candidate gateway.
DSH results and state were not replaced by fixture responses. This round
does not claim a successful new model reply.

| Operation | Observed result | Limit |
| --- | --- | --- |
| Open the model card and select the account-provided Flash model and Off reasoning | The visible selections were made in the real candidate interface. | This is not a new acceptance result for another DSH version or provider. |
| Keep the message draft while using model and reasoning controls | The draft was retained. | Physical-phone keyboard behavior was not tested in this round. |
| Create a goal, pause it and clear it | Independent reads returned active, paused and null respectively. | The QA goal was paused and cleared to avoid automatic continuation; this does not certify another host version. |
| Enter and exit plan mode | Both actions returned confirmed state readbacks. | This is the operated current runtime, not a compatibility claim for every historical npm version. |
| Compact the conversation | The real command returned: `Compaction could not produce a useful summary. The attempt is recorded in the session log.` The interface displayed failure. | No useful summary or successful compaction is claimed. |
| Attempt a model operation | The provider reported insufficient balance, and the error remained visible. | No successful model reply or recovery from exhausted provider balance is claimed. |
| Attempt a candidate-loopback message without a registered device proof | The request was safely rejected with `prompt-state-context-unavailable`. | A loopback key does not create a device identity. The check was not bypassed, and no successful candidate-loopback send is claimed. |
| Save the every-three-entry reminder and reload the actual candidate three times | After authentication and encrypted metadata were ready, stored counts were 4, 5 and 6; the popup was absent, absent and present respectively. | The local candidate's real metadata reported an unsupported/disabled backup route honestly. This verifies reminder timing, not a usable backup. |
| Open the manual backup panel | The panel remained available and showed the actual disabled/unavailable route rather than a usable address. | Other intervals and storage failures are covered by isolated tests, not this real reload sequence. |

These were source-candidate operations in a **390-by-650** desktop browser
viewport. They do not
establish compiled Preview.20 installation, physical-phone behavior or a
new end-to-end loading-time improvement.

## Separate installed Preview.19 public-route recheck

The installed production gateway was still **Preview.19**, not the
Preview.20 candidate. Through its real public HTTPS route, one QA message
was sent. Its exact user message appeared in history and its submitted
draft cleared. The provider then reported insufficient balance; a completed
assistant answer is not counted as passed.

The backup opt-in was enabled through the local computer console. Its
initial unreachable phase was not treated as ready. A later probe confirmed
ready/reachable state for the same gateway boot. The real production browser
then used the explicit preparation control to open the alternate entry in
a new window and verified that window's login, encrypted connection and
stored browser state. These are actual Preview.19 preparation observations,
not Preview.20 installed-package or new reminder-frequency acceptance.

## Backup reminder behavior

The candidate offers reminders after every 1, 3 or 5 qualifying entries, a
custom interval from 1 to 9,999, or never. The default is every entry.
Preferences and counters are stored locally for the current browser origin.
Only a fresh navigation or reload counts, after authentication and the
encrypted connection are ready. Conversation switching, reconnecting,
returning to an existing page and controller remounts do not add entries.

Choosing **Never** suppresses every automatic popup, including notices of a changed
backup address. The manual backup panel remains available. A disabled or
unavailable backup route must remain visibly unavailable, with setup
guidance instead of a working-looking connection. A copied address contains
no credentials; another origin still requires its own authentication and
encryption setup. If browser storage fails, the panel explains that the
preference or count may not survive reload. This feature does not create an
independent recovery network or bypass any connection check.

The actual candidate's every-three-entry reload sequence and manual
disabled-route panel are recorded above. Every-five, custom and never
intervals, changed-address behavior and unavailable storage are covered
separately by the isolated suites below. None has been certified on a
physical phone or through a compiled Preview.20 installation.

## Isolated and release verification

| Check | Status |
| --- | --- |
| Compact card, back action, independent drafts, lazy plan reads, serialized plan actions, stale goal protection and dialog disposal | Passed the 38-check controls suite using actual Chromium with a controlled adapter. |
| Project, conversation, queue, attachment and input actions | Passed the 203-check actions suite using an isolated browser and controlled services. |
| Reminder intervals, changed-address behavior, per-origin storage, disabled routes and unavailable storage | Passed `test-dsh-lite-backup.js`, `test-dsh-lite-backup-monitor.js` and `test-dsh-lite-backup-browser.js`. These are isolated fixtures; browser cases use actual Chromium. |
| Complete isolated CI suite | 136 passed, 0 skipped, 0 failed. Six live-only segments are explicitly excluded and are not counted as passes. |
| Strict public secret scan | Clean. This does not certify all historical commits or private computer data. |
| Public plugin package inventory and source-hash closure | Both local Preview.20 GitHub and npm distribution packages passed: 188 public members including the manifest, 187 source entries and 63 runtime dependencies. No lifecycle hooks, private files or archived integrations were included. The source package remains `private: true`. |
| Published Preview.20 asset hashes, compiled Windows installation and retained private state | Pending Preview.20 publication and actual installation. |
| Production browser operation after verified Preview.20 installation | Pending that installation. The separate installed Preview.19 observations above do not fill this check. |

Controlled adapter tests are not real DSH operations. A desktop browser at
a phone-sized viewport is not physical iPhone/Android, mobile keyboard or
cellular acceptance. No such new physical-device claim is made here.

## Distribution and compatibility limits

The community website's Preview.19 tarball update is submitted as
[PR #8350](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/8350),
awaiting maintainer review. That submission is separate from this candidate
and from the generated npm-backed Discover index. npm account authorization
and a real publication remain pending. The earlier local registry
installation and a publication dry run do not establish public availability
or package-name permission.

Exact admitted DSH versions are unchanged. Historical npm workflows are
preserved in the [compatibility matrix](DSH-COMPATIBILITY.md) and were not all
repeated for this candidate. No new old-wrapper or all-version compatibility
claim is made. Private connection information, account credentials and
personal notification automation remain outside public packages and docs.
