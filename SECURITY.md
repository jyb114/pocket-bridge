# Security policy

## Supported scope

New Pocket Bridge releases are DSH-only. They do not start a Codex/Dot reader, writer, native desktop relay, lock-release action, or quota service. Retired bookmarks and routes receive an unsupported response. Historical combined installers remain available, but their integration behavior is not a security claim for the current product.

The supported remote interface is the bridge-owned DSH phone UI. The original DSH web interface is available locally on the host; arbitrary upstream HTTP routes are not a remote fallback. This avoids exposing unknown plugin, history, file, or account endpoints that are outside the encrypted phone protocol.

## Connection authentication

Treat the complete connection URL as private. It contains an access capability and, for encrypted connections, a browser-local key fragment. Remote content routes also require the device proof and authentication checks implemented by the gateway. The phone must report expired authorization or a missing key; it must not bypass the check or silently send plaintext instead.

The desktop console is restricted to the local computer. Device revocation and key rotation are explicit local operations. An upgrade preserves the existing keys, device records, installation identity, and unknown configuration fields; it does not enroll new devices or reset credentials.

The phone content interface requires WebCrypto in a browser secure context: the HTTPS tunnel or a trusted local HTTPS entry. A plain LAN HTTP URL cannot provide that browser capability and must not silently downgrade protected content to plaintext. HTTPS certificate trust is a separate device configuration step.

## Encryption boundary

Bridge-owned message RPC, supported WebSocket content, legacy helper operations, and protected file transfers use the authenticated encryption protocol between the phone browser and the local gateway. Successful file decryption must come from that protocol, not a caller-supplied response header. A changed key, invalid authentication tag, missing encryption support, or malformed protected payload fails closed.

For these protected content channels, a passive TLS-terminating tunnel relay sees ciphertext rather than the message or file body. TLS alone would not provide that protection through a terminating relay. The relay can still see request timing, sizes, connection metadata, and public bootstrap assets. It also serves the initial page. An active relay or compromised origin that replaces that page or its scripts is outside the guarantee; content encryption is not protection against malicious code in the browser. Code pinning is an additional integrity check, not an independently trusted first installation.

The bridge-owned phone document restricts executable sources, outgoing connections, framing and browser permissions through response headers. This reduces unintended script and resource exposure; a serving endpoint able to replace the document can also replace its headers. It is not an independent trust anchor. Optional [private HTTPS](docs/TAILSCALE-PRIVATE-HTTPS.md) can deliver that first page without Cloudflare. It still depends on the serving computer, browser, TLS and tailnet trust model; its setup and physical-phone acceptance are separate from isolated gateway tests.

The current key schedule rotates derived keys but is not forward secrecy. Someone who later obtains the long-lived application secret can derive retained historical slots and decrypt recorded protected ciphertext. Protect the complete link and local key files, and rotate a compromised pairing secret; rotation does not make previously recorded ciphertext unrecoverable to a holder of the old secret.

DSH sends prompts and files to its configured model provider as part of ordinary model use. That provider is an intended recipient, independent of the tunnel protection. Optional notification and balance services have their own recipients and data boundaries.

## Files and local storage

Supported workspace reads and downloads resolve canonical real paths, bind them to the selected project/runtime, reject escapes and protected credential/configuration paths, and enforce transfer limits. Generic upload bytes and legacy image receipts have separate validation. The supported image-ID reader delegates session-reference authorization to DSH, accepts bounded raster data with matching IDs, digests and metadata, and never infers a filesystem path from tool text. Generic file uploads may have a temporary, bounded browser-memory preview; it does not create a remote read permission or persist the original file. An attachment without an authorized retrievable source is not represented as a successful download.

These gateway limits do not restrict tools independently authorized through DSH. Review the target's own permissions and approvals. A requested permission change is not effective merely because a command was sent; the phone should claim it is applied only after a valid current-runtime readback.

DSH history, workspace files, uploads, target credentials, and browser drafts are separate at-rest boundaries. Some may be plaintext on the computer or in browser storage. Anyone who can run malicious code as the logged-in user, read the local keys, or control the phone/computer can bypass this boundary. Do not describe the whole product as encrypted at rest.

Existing Codex/Dot journals and uploads are retained during a DSH-only upgrade. They become inert historical data, not current endpoints. The upgrade does not recursively erase local directories or close target applications.

## Delivery and availability

Temporary tunnels can disconnect or change address. A transport error is not proof that an instruction was rejected. Preserve drafts and ambiguous delivery outcomes; never automatically resend a possibly accepted operation. Queued-message edits require readback before reporting success, and a failed or unknown acknowledgement must not discard the user's edited text.

Runtime identity, authorization, replay defenses, and file scope remain in place during performance optimization. Verified inbound protected mobile/Lite HTTP bodies and WebSocket content, together with one-shot proof nonces, now have bounded server-side durable admission receipts committed before dispatch. They survive an ordinary gateway restart; invalid cryptographic input cannot reserve a receipt. Active receipts are not evicted to make room, and journal/checkpoint disagreement, capacity, storage, concurrent-lock or clock rollback errors refuse admission. The ledger contains receipt metadata, not messages or keys, and must be retained with installation data. Do not delete it to work around an error. Downstream streamed replies are not synchronously journaled per token.

Admission receipts are not an execution journal or an exactly-once application protocol. A request may have been admitted when its reply is lost, and a newly encrypted repeat with a different nonce is not the same cryptographic replay. The current envelope does not authenticate HTTP method/path, device cookie, or message order; the device-cookie check is a separate authorization gate. The browser's received-message replay cache is not made durable across page reloads, and the first ledger deployment cannot recognize packets accepted by older unjournaled gateways. A local administrator who can replace the application and its entire state is outside this defense. A successful isolated test is not proof of every physical-device, runtime-version, or internet condition.

The screenshot route accepts only its exact bounded width request. Unknown fields, malformed types and unrelated RPC bodies are refused before temporary-file creation or capture. This closes the tested cross-route screenshot trigger; strict request schemas do not replace cryptographic binding of the requested operation and do not establish protection against every active relay.

## Reporting

Never post keys, complete connection URLs, account details, private logs, uploaded files, or full transcripts in a public issue. For a sensitive report, contact the maintainer through a private channel already agreed with them; this repository does not publish a personal messaging address. Public non-sensitive bugs can use [GitHub Issues](https://github.com/jyb114/pocket-bridge/issues).

Before publishing, scan public source, installer payload, and compiled artifacts for secrets and local notification data. Keep runtime license notices. Check both positive encrypted operations and negative unauthorized/retired routes; do not weaken a check merely to make a fixture pass.
