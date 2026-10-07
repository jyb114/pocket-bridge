# Release notes - 1.0.0-preview.11

## List row layout fix

This patch prevents project and conversation rows from shrinking inside scrollable lists, so long titles and their secondary text no longer overlap the next row. It changes only this layout rule. Preview.10 functionality, compatibility scope and security limits remain unchanged; the existing release information follows.

Pocket Bridge continues as a lightweight, unofficial mobile interface for DeepSeek Harness on your own Windows computer. New installers are DSH-only. Previous combined Codex/Dot releases and installers remain available; this release does not delete target applications or historical conversations.

## Privacy improvements

- Persist replay receipts for protected inbound mobile HTTP and WebSocket content and one-shot device proofs before dispatch. An already consumed packet stays refused after a gateway restart. Invalid authentication does not consume a receipt. Corruption, storage failure, conflicting ownership or capacity exhaustion refuses the request rather than clearing protection.
- Reject malformed, fragmented, oversized and unsupported WebSocket frames before forwarding. Retain legitimate control frames and bounded encrypted content.
- Apply a restrictive same-origin policy to the bridge-owned phone page, with no third-party scripts or fonts, no referrer and no framing. This reduces unintended loading; it does not authenticate a page that an active serving provider has replaced.
- Require an exact screenshot request schema. An encrypted ordinary RPC body cannot be redirected to this route to trigger the tested unintended screen capture.
- Add an optional private Tailscale HTTPS entrance, disabled by default. It checks the configured local Serve mapping and keeps Bridge authentication, device proof and encryption. It does not install Tailscale, log in, change network settings or enable Funnel. See [setup and limits](docs/TAILSCALE-PRIVATE-HTTPS.md).

Passive tunnel relays receive ciphertext for protected content, but still see metadata. The initial web application remains a separate trust boundary. Encryption is not forward-secret and does not bind HTTP method/path, device cookie or packet order. This is not an exactly-once execution guarantee. Model providers receive the instructions DSH submits to them, and local files/drafts have separate storage boundaries. See [SECURITY.md](SECURITY.md).

## Compatibility and usability

- Show the observed distribution, exact runtime version and adapter in Settings → Connection and compatibility. Separate implemented interfaces from workflows accepted by real operation. Unknown future versions remain unverified.
- Make unsupported legacy permission, plan, goal, queue and generic-file interfaces explicit. Keep available model and tool controls usable instead of disabling the whole conversation.
- Implement legacy model and blank-session tool-preset selection through the old runtime's actual methods, with independent readback before claiming success. Selection writes trigger fresh runtime verification.
- Repair legacy history refresh markers: record a revision only after its matching history has been read successfully. A failed initial read or periodic read can therefore be fetched again even when the upstream revision is unchanged.
- Preserve history and drafts during a specifically recognized temporary legacy background-read failure. Continue read retries, show a scoped warning, and clear only that warning after recovery. Authorization, protocol and operation errors remain visible. Messages and other writes are never automatically resent.

The existing compact phone layout, explicit image loading, local artwork, 44-pixel primary touch targets and Chinese/English/Spanish interface remain. Public product documentation and release notes are in English. Private notification scripts, access links, credentials and user files are excluded from published source and installers.

## Actual operation and limits

The current desktop baseline is **DSH 0.1.7-rc.2**. Four real published npm packages were also run locally in separate D-drive homes: **0.1.0-rc.8, 0.1.1-rc.2, 0.1.7-rc.2 and 0.2.0-rc.2**. Project/session, file, model, preset and image flows have different acceptance scopes. Modern npm sessions returned real replies and completed actual question/answer and approval allow/reject operations. Old npm project/session, file preview, staged image and model/preset readback were operated; successful model replies and model-triggered interactions remain blocked by unavailable valid legacy credentials.

Prepared historical dependency graphs are not certification of today's default fresh `npx` installation. A fresh unmodified old npm installation timed out before startup; that result does not establish either success or a dependency-resolution defect. The lost laptop's desktop executable, arbitrary plugins, future releases, physical iPhone/Android and cellular workflows remain unverified. Current in-app-browser Save operations did not confirm a completed download. Historical successful downloads and controlled byte-exact fixtures are recorded separately.

Publication is gated on independent CI for the exact commit, compiled installer acceptance and source/payload/privacy checks. These are separate from actual runtime operation and device acceptance. See the [compatibility matrix](docs/DSH-COMPATIBILITY.md) and [acceptance record](docs/DSH-MOBILE-ACCEPTANCE.md).
