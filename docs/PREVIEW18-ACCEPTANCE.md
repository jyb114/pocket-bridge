# Preview.18 acceptance

## Scope

Preview.18 changes the lightweight phone layout and public asset loading. It
does not expand the declared DSH versions or change the encrypted content
protocol. The [compatibility matrix](DSH-COMPATIBILITY.md),
[Preview.16 record](PREVIEW16-ACCEPTANCE.md) and
[Preview.17 record](PREVIEW17-ACCEPTANCE.md) retain their separate historical
scope.

## Isolated layout and cache checks

The browser layout fixture operates at phone-sized desktop-browser viewports,
including 375 and 390 pixels wide by 650 pixels high and a 400-pixel-high short
viewport. It checks the available transcript area, a long draft, focus and
visual-viewport transitions, the expandable conversation settings, menu actions,
older-history scroll anchoring and restoration of the desktop controls. These
are controlled fixtures, not physical iPhone, Android or cellular acceptance.

The public representation cache passed 27 focused checks. They include the
selected Brotli quality, decoded source digest, gzip fallback, exact validators,
source replacement and failure handling, cache bounds, private-route exclusion
and the Lite page's response security policy. The code-pin, Service Worker cache,
emergency updater and updater localization suites also passed without changing
their security rules.

The actual Service Worker passed 27 additional isolated checks. These exercise
the ten-path cache boundary, per-hit SHA-256, missing/corrupt/legacy cache
entries, fresh noncode responses even during storage failure, initial pinning,
whole-pin and epoch changes during reads, same-hash changes, bounded retries,
staged-update conflicts and failed commits. No authentication, HTML, API or
private message/file response is admitted to the new script-cache fast path.

Nine tests execute the actual UI selection functions against synthetic state
and storage. A hide or reload during initialization retains its pending choice;
an active user choice takes priority, a project switch invalidates the old
candidate, and authoritative validation can still discard a missing session.
These do not establish every browser lifecycle transition on a physical phone.

## Controlled server compression measurement

The actual public cache implementation was measured offline on one fixed
snapshot of the 12 public script/style files loaded by the Lite page. Both
configurations read and validated the same 663,765 source bytes. The baseline
used the previous default Brotli codec; the candidate used quality 5. The run
retained source-byte hashes, file-identity validation and the cache's normal
read path.

| Metric | Previous default Brotli | Brotli quality 5 |
| --- | ---: | ---: |
| Cold cache | 1,199.970 ms | 42.526 ms |
| Warm cache | 4.839 ms | 4.424 ms |
| Compressed bytes | 160,143 | 179,248 |

This single controlled run measures compression and validation work on the
server. It is not a statistically repeated phone benchmark or a promised
internet loading improvement. The additional 19,105 compressed bytes may have
a different network cost on each connection. Private messages and files do not
enter this public cache. Gzip remains at level 6.

## Live browser acceptance

The candidate was operated through the real Cloudflare Quick HTTPS entrance
with the original native DSH 0.2.1-rc.2 host, in desktop Edge at a measured
390-by-650 phone viewport. The existing old pin produced the normal update
notice; the visible verified-update action was operated before the new UI was
measured. These were real browser/runtime operations, not mocked model replies,
but they are not physical iPhone, Android or cellular tests.

| Observed metric | Before | Candidate |
| --- | ---: | ---: |
| Transcript height | 188 px | 492 px |
| Composer height | 239 px | 105 px |
| Largest Lite script response | 3,515 ms | 23 ms |
| DOMContentLoaded | 4,593 ms | 1,653 ms |
| First conversation content | 8,751 ms | 9,400 ms |

The ten fixed scripts in the final measured run were delivered through the
Service Worker from the verified local cache; the other scripts took roughly
43–52 ms. The largest script had one response, not a second preload download.
The first-content metric did not improve in these single observations. One
earlier measurement had no conversation selected and timed out; it is not
counted as a successful content load. An intermediate network-loading candidate
took 11,230 ms and is not substituted for the original baseline.

Actual browser interaction opened the conversation settings pickers, the file
browser and activity view, then returned to the conversation. Stop was operated;
the next synthetic model prompt returned the requested `PB18_UI_OK` reply.
Another real reply returned `PB18_RENDER_OK` with two distinct paragraphs,
three list items and a two-line code block. Its paragraph container used normal
whitespace, while the code block retained preformatted whitespace. The visible
result was inspected, separately from the isolated layout assertions.

For the pending-choice lifecycle check, a normal reload was followed by another
normal reload while the mounted UI still reported Connecting. The original QA
conversation then restored automatically, reached Connected and loaded its
actual records without manually selecting it again.

## Remaining startup bottleneck

A separate measured live startup spent about 4.65 seconds before its WebSocket
opened. Existing gateway timestamps attributed about 3.07 seconds to local
runtime/authentication setup before forwarding the upstream connection.
Read-only live diagnostics using the same configured DSH environment then
measured cold runtime resolution at 3,599 ms: process inventory took 3,464 ms,
owned-listener discovery 81 ms and the loopback fingerprint 49 ms. Installation
detection took 332 ms in parallel with process inventory. Upstream
authentication took 4.9 ms cold and 0.3 ms warm; its one credential location
snapshot took less than 0.1 ms. No credential values are included in this record.

A further inventory run took 3,702 ms, of which its PowerShell query consumed
3,367 ms; installed-version reads contributed most of the remaining time.
Equivalent read-only queries with projected fields did not establish a useful
improvement. These are individual observations on one Windows computer, not
universal performance bounds. The release retains the existing runtime cache
lifetime, live identity checks and authentication. It does not introduce a
persistent inventory service or claim that total loading is now fast.

## Limits

Public scripts keep their individual paths, code fingerprints and deferred
execution order. Preloading the existing largest script does not bypass Service
Worker validation or authorize a new code path. Existing pins require the
normal explicit verified update; they are not silently replaced.

Performance depends on the PC, tunnel, network, current history and model
provider. No all-version, offline, universal exactly-once or physical-phone
compatibility guarantee is made. Old release artifacts are retained.
