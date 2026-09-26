# Security

Pocket Bridge is an unofficial, self-hosted gateway for accessing DeepSeek Harness (DSH) or Codex running on your own computer from a phone browser. It is not a hosted service or a multi-user security boundary. The computer, its accounts, and the separately installed DSH or Codex remain under your control.

## Reporting a vulnerability

Please do not post exploit details or secrets in a public issue. Once this repository is public and GitHub Private vulnerability reporting has been enabled, use **Security → Report a vulnerability**. GitHub does not offer that feature for a private repository; the maintainer must enable and verify it immediately after publication. If the button is not available, you may open a *non-sensitive* issue asking for a private reporting channel, without including vulnerability details.

Include the Pocket Bridge version, operating system, affected component, impact, and minimal reproduction steps. Remove access keys, full connection URLs, cookies, account data, and personal content from any report. This is a personal project; no response time or service-level agreement is promised.

## What the current protection does and does not cover

The full connection URL is a credential. Its path contains an access key, and its `#` fragment contains a separate secret used for client proof and protected content channels. A six-digit pairing code alone does **not** authorize access to protected conversations. Keep the complete URL private and rotate keys if it may have leaked.

For a TryCloudflare connection, Cloudflare terminates HTTPS. It can see URL paths, cookies, traffic timing and size, and any request or response that Pocket Bridge has not separately encrypted. The fragment is not normally sent in the HTTP request, but that fact does **not** make it safe from an actively malicious relay: a changed first page or a redirect can disclose it. The first page and its scripts are not end-to-end authenticated. Code-integrity checks cannot establish trust in the very first page delivered by that relay.

Current application-layer encryption is **partial**:

| Channel | Current boundary |
|---|---|
| Codex | Covered real-time and content channels require application-layer encryption over a relay; this does not certify every possible Codex request or the first page. |
| DSH real-time WebSocket | Application-layer encryption is used for the covered event stream. |
| DSH prompt and binary upload | The current phone client encrypts these outbound request bodies. This is opportunistic for compatibility: an older client without the encryption marker can still be forwarded. |
| Other DSH HTTP APIs and history responses | Not comprehensively covered; some content or metadata may be visible to the TLS-terminating relay. |

The gateway also requires proof of the fragment secret before serving protected HTTP or WebSocket content to a remote device. This reduces what someone can do with the access key from the URL path alone; it does **not** protect against a relay that can replace the page or redirect the browser. A successful device proof is temporarily retained by device ID, including across gateway restarts. A relay that obtains an already-proven device cookie may reuse that device's access window; do not treat proof as protection against a malicious relay. Encryption failures on protected channels are intended to fail closed, but testing is not a guarantee of complete coverage or security.

Rotating only the `#` fragment secret changes the content-encryption secret; it does **not** revoke the access-key path, existing device cookies, or an already-retained device proof. If the complete link, a cookie, or a device may be compromised, revoke that device and rotate the **access key** with session revocation. Unencrypted DSH API paths remain outside the content-encryption boundary described above.

On a local network, the HTTP entry point is plaintext; the optional local HTTPS entry point uses a local certificate that your device must validate appropriately. A direct Internet HTTP entry point is also plaintext. See [README.md](README.md) for the supported connection modes and their trade-offs.

## Outside the security boundary

- A compromised computer or phone, or anyone who can read local keys or browser storage.
- An active TLS-terminating relay that changes the first page or redirects the browser.
- Traffic metadata, denial of service, and reliable delivery of temporary tunnel or notifications.
- Third-party services used by optional notifications or balance checks; enabling them may disclose notification content or account data to those services.
- Perfect replay prevention across gateway restarts. Replay defenses are best-effort and are not a substitute for a persistent, end-to-end protocol sequence.

## Safer use

- Prefer the local encrypted entry point when the phone and computer are on the same trusted network. A self-managed transport that keeps TLS termination on your computer avoids the third-party HTTP relay, but requires careful certificate and network configuration.
- Use only the complete connection URL copied from the computer console; do not publish or screenshot it. A changed tunnel address or rotated key requires updating the phone bookmark or home-screen shortcut.
- Keep the host computer and DSH/Codex updated. Revoke unused devices and rotate keys after suspected disclosure.
- Run `node scripts/secret-scan.js --strict` before publishing source. This check does not prove that the application is secure.
