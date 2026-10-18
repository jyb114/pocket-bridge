# Preview.16 acceptance

This record separates original application operation, live browser workflows,
isolated fault injection and untested devices. It is not a claim of universal
DSH compatibility or complete desktop feature parity.

## Environment

- Windows x64; genuine Node.js 24.18.1 for the gateway.
- Official native DSH 0.2.1-rc.2, verified against the official Windows feed's
  SHA512 and Authenticode signature. Extracted application files ran in a
  separate D-drive DSH home and Electron profile. The existing 0.1.7-rc.2
  installation and its conversations were preserved.
- A real Edge browser with a 390 by 844 viewport, operated through visible
  controls over actual Cloudflare HTTPS Quick Tunnels. This is a desktop
  browser viewport, not an iPhone, Android handset or cellular-network test.
- A dedicated D-drive workspace with synthetic text and image files. Model
  replies below are actual account-provider responses, not mock fixtures.

## Observed live operations

| Surface | Action and observed outcome |
| --- | --- |
| Original DSH desktop | Completed the original first-run controls, selected Account DeepSeek-V4.1-Flash with its 1017 badge and read-only permission, submitted a no-tools prompt, and observed the exact requested `PB16_NATIVE_1017_OK` response. |
| Phone HTTPS page | Loaded the real workspace catalog and the desktop-created conversation, with connected/encrypted state. |
| Phone workspace and conversation | Browsed to the dedicated computer directory, added it as a workspace and created a new conversation through the actual phone controls. |
| Phone model and permission controls | Selected the Account Flash model and Low reasoning. Changed to read-only through the visible permission panel and observed the independent current-permission readback. |

This record is updated with the remaining operated workflows before publication.
An accepted send is not, on its own, a completed model reply. An uploaded file
receipt is not, on its own, proof that the model read that file.

## Receipt recovery boundaries

The modern adapter stores no prompt plaintext in its receipt journal. Its
exclusive durable decision permits at most one bridge dispatch for one request
identity. Reloads and explicitly prepared alternate entrances retain the
authenticated device identity. A new browser identity or a separately paired
device does not inherit the old device's records.

An uncertain operation is not retried automatically. A user may review history
and the queue, then explicitly authorize a separate new message; that distinct
operation can still duplicate an earlier task whose outcome remains unknown.
Identical intentional questions are not globally removed by their text.
Legacy adapters retain the manual review barrier rather than claiming this
modern receipt protocol.

## Separate automated checks

Durability, lost-receipt recovery, actual owned-process restart/concurrent
admission, revocation during asynchronous discovery, storage failure and
late-UI-result checks use isolated fixtures. They do not constitute original
DSH model replies or physical-phone acceptance. Test-browser cleanup is scoped
to its owned connection, process and profile.

## Not established by this release record

- Physical iOS/Android keyboards, camera pairing or cellular-specific behavior.
- Every older npm package or another desktop wrapper with Flash-1017.
- Every third-party desktop plugin, future DSH version or model provider.
- Uninterrupted availability when the PC, gateway, network or Cloudflare fails.
- Protection against an actively substituted first page without an independent
  trust check, or against a compromised endpoint computer.

See [compatibility](DSH-COMPATIBILITY.md), [security](../SECURITY.md) and the
[dual-tunnel guide](DUAL-TUNNELS.md) for the remaining product boundaries.
