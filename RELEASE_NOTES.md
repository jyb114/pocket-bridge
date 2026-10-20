# Release notes - 1.0.0-preview.19

Prepare a verified npm distribution without changing the running DSH protocol
or the phone interface. The source checkout remains private. Only an explicit
`node scripts/build-dsh-plugin.js --npm <artifact-directory>` build makes its
controlled temporary package stage publishable, with repository metadata,
the public registry, access and distribution tag.

The npm candidate retains the same package identity, Cordis component and
managed gateway location. Its public-file allowlist, source manifest, complete
runtime dependency closure and disabled lifecycle hooks remain enforced.
Normal GitHub archives and the Windows installer retain their existing build
path. Existing pairing records, uploads and private state remain upgrade data.

## Discover availability

The community website accepts the GitHub release tarball. Its generated
Discover index currently requires verified npm metadata, an exact version and
a publication timestamp. These are separate distribution paths. A configured
local test index or successful `npm publish --dry-run` is not a public npm
publication and does not establish public Discover availability.

The DSH custom plugin market must also be enabled and given a trusted index
source. The stock host does not configure one by default. Read the complete
[distribution instructions](docs/DSH-PLUGIN.md#preparing-an-npm-distribution)
before publishing. Package-name permission and npm account authorization must
be established separately from the GitHub account.

## Verification and compatibility

Official npm DSH Web 0.2.1-rc.2 was operated in a separate Windows profile:
enable the custom market, add the community index, search, add a clearly
labelled local validation index, inspect the candidate, install its real
archive through the host's pnpm operation, enable it, open Pocket Bridge
Settings, start and diagnose the matching gateway, cancel and confirm Stop,
then disable and re-enable the component. Local fixtures are not presented
as a public registry listing. Model replies and transport responses are not
fabricated. Version-specific final observations are recorded separately.

The exact host gates are unchanged. Optional plugin declarations for
0.1.7-rc.2, 0.2.0-rc.2 and 0.2.1-rc.2 are distinct from rerunning every
workflow on every host. The desktop baseline remains official 0.2.1-rc.2.
Physical iPhone/Android and cellular acceptance remain separate from desktop
browser phone viewports. See the [compatibility matrix](docs/DSH-COMPATIBILITY.md).

Personal notification scripts, account authorization and connection secrets
are not part of the public source, npm package or Windows installer.

The isolated first-load banner test now uses a deterministic virtual clock.
It retains strict visibility/removal checks and adds timing boundaries. The
production banner code is unchanged. The complete 135-suite isolated run
passed; six live-only segments are explicitly excluded and are not counted
as passed. Read the separate [Preview.19 acceptance record](docs/PREVIEW19-ACCEPTANCE.md).

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
