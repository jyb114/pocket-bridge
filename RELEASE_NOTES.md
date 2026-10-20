# Release notes - 1.0.0-preview.20

Make the phone's conversation controls more compact and remove avoidable
waits while preserving drafts and the existing encrypted connection.

## Compact model, goal and plan controls

Model and reasoning choices now share one compact card. Its back action
returns to the model list without replacing the dialog. A successful picker
choice closes after 150 ms instead of 700 ms; failed choices remain visible
with their error.

Permission selection uses the same compact card. Back and tab controls keep
44-pixel touch targets; editable goal and reminder fields use 16-pixel text.
The goal panel explains that saving can start DSH immediately, while the
message draft stays separate.

Goal, plan and context-compaction controls use separate tabs. The message
draft stays separate from goal input. Opening the goal tab no longer fetches
plan selection and command lists; those reads start when the plan tab is
opened. This removes unnecessary work rather than weakening runtime checks.

Plan entry and exit actions cannot run concurrently. Closing or disposing
the interface removes dialog listeners and clears its page-inert state, so
a remounted page remains usable. A completed goal or stale context cannot
be presented as a confirmed edit; uncertain text remains available for
review and a fresh read.

## Backup-address reminder frequency

Choose every 1, 3 or 5 qualifying entries, a custom interval from 1 to 9,999,
or never. The default is every entry. The preference and count belong to the
current browser origin. Only a fresh navigation or reload counts, after
authentication and encryption are ready. Reconnection, conversation changes
and returning to an existing page do not add entries.

Choosing **Never** disables all automatic popups, including changed-address notices.
The manual backup panel remains available. A disabled backup route is
reported as disabled with setup guidance, and unavailable browser storage
is reported instead of promising a persistent interval. A copied backup
address contains no credentials; a different origin still needs its own
login and encryption setup. No connection or content protection is bypassed.

## Verification and compatibility

The real candidate interface was operated against **DSH 0.2.1-rc.2** to
select the account-provided Flash model and Off reasoning, retain the message
draft, create/pause/clear a goal with independent state readbacks, and confirm
plan entry and exit through readbacks. The real compaction attempt returned
that it could not produce a useful summary, which the interface displayed
as a failure. A model attempt also reported insufficient provider balance;
no successful model reply is claimed for this round. A candidate-loopback
send without a registered device proof was safely rejected rather than
bypassing the prompt-state check.

The complete isolated run passed **136 suites, with 0 skipped and 0 failed**;
six live-only segments are explicitly excluded from that count. The strict
public secret scan was clean. The 38-check compact-controls suite, 203-check
actions suite and three backup suites passed. Controlled adapter results are
kept separate from real DSH operations.

The installed **Preview.19** public route separately accepted one QA message
into history and cleared its draft, then displayed insufficient provider
balance. Its backup later passed the same-boot reachability probe and actual
browser preparation, including a new window's login, encrypted connection
and stored state. These observations do not establish Preview.20 installation
or a successful model answer. In the actual candidate at 390 by 650 pixels,
every-three-entry reminders were also saved and checked through three real
reloads: counts 4, 5 and 6 produced no popup, no popup and one popup. The
manual panel reported that candidate's unsupported/disabled backup state
honestly. Other frequency variants remain isolated-test evidence.
Both local Preview.20 GitHub and npm distribution packages passed their
public inventory and source-hash checks: 188 public members including the
manifest, 187 source entries and 63 runtime dependencies, without lifecycle
hooks, private files or archived integrations. The source remains
`private: true`. Compiled Preview.20 installation and its post-installation
production recheck remain unperformed in this record. See
[Preview.20 acceptance](docs/PREVIEW20-ACCEPTANCE.md) for the exact boundaries.

The exact host gates are unchanged. Optional plugin declarations for
0.1.7-rc.2, 0.2.0-rc.2 and 0.2.1-rc.2 do not establish that every workflow
has been rerun on each host. This round makes no new physical iPhone/Android,
cellular or old-wrapper compatibility claim. See the
[compatibility matrix](docs/DSH-COMPATIBILITY.md).

Personal notification scripts, account authorization and connection secrets
remain outside the public source, npm package and Windows installer.

## Distribution status

The community website's Preview.19 GitHub tarball update has been submitted
as [PR #8350](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/8350)
and is awaiting review. Its website listing and the generated npm-backed
Discover index are separate distribution paths.

npm account authorization and publication remain pending. The explicit
`node scripts/build-dsh-plugin.js --npm <artifact-directory>` build prepares
a verified publishable stage; the source package remains `private: true`.
A local test index, a successful installation from it, or
`npm publish --dry-run` is not a public npm publication and does not establish
name ownership or Discover availability. The existing public-file allowlist,
source hashes, dependency closure, disabled hooks and private-state retention
remain in place. Read the
[distribution instructions](docs/DSH-PLUGIN.md#preparing-an-npm-distribution).

## Previous release: 1.0.0-preview.19

Prepared the explicit verified npm distribution path while retaining the
normal GitHub archive and installer path. Real npm-host plugin installation,
private-state retention, separate HTTPS phone-view operations and strict
delayed-focus regressions remain recorded in
[Preview.19 acceptance](docs/PREVIEW19-ACCEPTANCE.md). They are historical
results, not a substitute for the final Preview.20 checks.

## Previous release: 1.0.0-preview.18

Give conversations more room on phones. The title and connection indicator now
share one top row. Session actions and activity controls are available in the
labelled menu. Model, tool, permission and goal choices open from the composer's
conversation-settings button, which shows the current model.

The resting composer is smaller, long drafts scroll inside a bounded input,
and layout follows the available visual viewport. The older-history control
appears at the beginning of the transcript while pagination preserves the
reading position. Wider desktop layouts retain their original controls and
state.

The largest Lite script is preloaded from its existing URL. Public assets use
Brotli quality 5 to reduce first-miss server compression work; gzip remains at
level 6. In a controlled offline run of the real cache on the same 12 public
files, cold compression fell from about 1,200 ms to 43 ms, while compressed size
increased from 160,143 to 179,248 bytes. This is a server measurement, not a
guaranteed phone or tunnel load time.

Source validation, encoding-specific ETags, cache limits, code fingerprints,
explicit verified updates and authenticated encrypted content remain in place.
Ten fixed public scripts can now be served from the phone's verified cache,
with their bytes, current pin and access-key epoch checked again before use.
There is no per-script background revalidation. Navigation, authentication,
APIs, the emergency updater and fresh manifest checks stay online. Key rotation
and explicit update commits invalidate stale cache decisions. First visits,
new origins and missing cache entries still need a download.

An early hide or reload also preserves a pending conversation choice until its
first list can be checked. Switching projects invalidates that pending choice;
missing conversations are not retained indefinitely.

No private messages or files are added to the public asset cache. The DSH
version gates and supported protocols are unchanged.

## Validation scope

The full isolated layout fixture covers compact and short viewports, long
drafts, focus, menus, settings, history anchoring and restoration of the desktop
layout. The public cache's 27 checks, 27 worker-cache and trust-context checks,
nine actual-function selection checks and the related fingerprint/update
suites passed.

On the real Quick HTTPS entrance in desktop Edge at 390 by 650 pixels, the
transcript grew from 188 to 492 pixels and the composer shrank from 239 to 105
pixels. The measured largest-script request fell from 3,515 to 23 ms and
DOMContentLoaded from 4,593 to 1,653 ms. First conversation content took 9,400 ms,
versus 8,751 ms before: these single runs do **not** establish an overall loading
improvement. Separate read-only live diagnostics measured fresh Windows process
inventory at about 3–3.7 seconds, while upstream authentication took under 5 ms.
That local startup bottleneck remains; version detection and authentication
have not been weakened to conceal it.

The real browser operated the conversation settings, files and activity views,
returned to the conversation, stopped a task and received the requested reply
from the next synthetic prompt. Another real reply verified paragraphs, lists
and a two-line code block. These were desktop-browser phone viewports, not
physical iPhone/Android or cellular tests. Full observations and limits are
recorded in [Preview.18 acceptance](docs/PREVIEW18-ACCEPTANCE.md).

The [Preview.17 startup record](docs/PREVIEW17-ACCEPTANCE.md) and broader
[Preview.16 acceptance](docs/PREVIEW16-ACCEPTANCE.md) remain historical results;
they do not imply every old host was retested with this release. Existing
releases and installers are retained. Personal notification scripts and
account settings are not included.
