# Release notes - 1.0.0-preview.9

## DSH-only direction

New Pocket Bridge releases focus on DeepSeek Harness. Codex and Dot are removed from current gateway startup, routes, target discovery, desktop controls, and Windows payload requirements. Old bookmarks receive an unsupported response. Previous GitHub releases and installers remain available; they are not deleted or updated.

An upgrade retains the installed directory, connection keys, devices, configuration, uploads, and historical journals. It does not close the target applications or erase their conversations. The new installer does not bundle DSH, model access, or a subscription.

## Mobile interface

- Replace the narrow persistent phone rail with a compact top bar and full-width conversation area. Move secondary actions to a labelled menu and give primary controls at least 44-pixel touch targets.
- Keep model, tool preset, permission, and goal controls visible in their own row. Phone Return inserts a newline; Send remains explicit.
- Use original Pocket Bridge SVG/PNG/Windows artwork and local system fonts. The 512-pixel app icon is 5,314 bytes instead of 289,816 bytes; the matching master artwork is 5,314 instead of 1,403,547 bytes. These are asset-size reductions, not a measured claim of equal startup improvement.
- Preserve queued-message and goal edits until an authoritative read confirms the change. An uncertain response keeps the edit and offers readback rather than silently discarding or resending it.
- Bind asynchronous command actions to their original session. Report command errors and unsupported results instead of inventing completion. Permission success requires a current-runtime readback.
- Hide Stop after the latest task has ended. Preserve the last goal when reading its current state fails, with an unavailable-state explanation.
- Reuse unchanged message rows, retain opened reasoning and loaded images, and coalesce streaming layout work. Images remain explicit, and a decoder failure exposes a working Retry instead of retaining a broken source.
- Read supported image references through DSH's session-authorized attachment API. Validate raster bytes and metadata before returning encrypted content. Generic uploaded images have a separate bounded preview on the current page; it is temporary and does not claim remote history retrieval.
- Run process, listener and cold installation discovery asynchronously. Keep runtime identity checks, cache expiry and failure invalidation, while avoiding blocking the gateway during slow system queries.

## Privacy and compatibility

Remote original-interface HTTP and unknown WebSocket paths are closed before upstream dispatch. The supported phone uses the bridge-owned encrypted Lite protocol. Computer-local access to the original DSH interface remains available. Authentication, device proof, encryption, file boundaries, and size limits remain enforced.

Malformed, oversized or non-101 upstream WebSocket handshakes fail closed, and a transform failure closes only the connection. The phone requires a secure browser context: an HTTPS tunnel or trusted local HTTPS. Plain LAN HTTP is not an encrypted phone fallback.

The current desktop baseline is **DSH 0.1.7-rc.2**. This is an exact-version statement, not a promise about every future desktop release. Historical actual npm tests for 0.1.0-rc.8, 0.1.1-rc.2, 0.1.7-rc.2 and 0.2.0-rc.2 cover different subsets. The oldest model replies and several approval workflows remain unverified. See [DSH compatibility](docs/DSH-COMPATIBILITY.md) for evidence and limits.

Content encryption protects the supported channel from a passive tunnel relay. Traffic metadata and the initial web application remain outside that body-confidentiality boundary; a malicious serving endpoint or compromised device is not covered. Model providers receive the prompts DSH submits to them. Local storage is a separate boundary. See [SECURITY.md](SECURITY.md).

## Verification status

The release acceptance record separates isolated browser/security checks, current-desktop public-route operations, historical npm operations, compiled installer checks, and physical-device limits. A displayed card or a successful service startup is not counted as a completed action. See [DSH mobile acceptance](docs/DSH-MOBILE-ACCEPTANCE.md).

Actual public-route operation with desktop DSH 0.1.7-rc.2 passed project/conversation creation, assistant replies, model and permission readback, file preview, uploaded-image model reading, temporary fresh-upload preview, one historical official tool-image preview, encrypted computer-screen reading and the 390/320-pixel layout checks. Updating and reloading the installed page also preserved English across static and dynamic controls. Old generic pathless uploads do not gain remote retrieval from the official image-reference result. Public download completion and physical-device workflows remain unverified.

The current controlled Chromium action fixture passed 192 checks. An earlier candidate passed 89 isolated CI entries; the latest language/runtime edits still require fresh final CI and installer validation. Release assets are published only after the final source, compiled installer, payload and privacy gates pass. Earlier candidate results must not be presented as final release acceptance.
