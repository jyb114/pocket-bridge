# Security

Pocket Bridge is an unofficial, self-hosted gateway for accessing DeepSeek Harness (DSH) or Codex running on your own computer from a phone browser. It is not a hosted service or a multi-user security boundary. The computer, its accounts, and the separately installed DSH or Codex remain under your control.

## Reporting a vulnerability

Please do not post exploit details or secrets in a public issue. Once this repository is public and GitHub Private vulnerability reporting has been enabled, use **Security → Report a vulnerability**. GitHub does not offer that feature for a private repository; the maintainer must enable and verify it immediately after publication. If the button is not available, you may open a *non-sensitive* issue asking for a private reporting channel, without including vulnerability details.

Include the Pocket Bridge version, operating system, affected component, impact, and minimal reproduction steps. Remove access keys, full connection URLs, cookies, account data, and personal content from any report. This is a personal project; no response time or service-level agreement is promised.

## What the current protection does and does not cover

The full connection URL is a credential. Its path contains an access key, and its `#` fragment contains a separate secret used for client proof and protected content channels. A six-digit pairing code alone does **not** authorize access to protected conversations. Keep the complete URL private and rotate keys if it may have leaked.

For a TryCloudflare connection, Cloudflare terminates HTTPS. It can see URL paths, cookies, traffic timing and size, and any request or response that Pocket Bridge has not separately encrypted. The fragment is not normally sent in the HTTP request, but that fact does **not** make it safe from an actively malicious relay: a changed first page or a redirect can disclose it. The first page and its scripts are not end-to-end authenticated. Code-integrity checks cannot establish trust in the very first page delivered by that relay.

Application-layer encryption depends on the phone view and route. It does not authenticate the first page delivered by the tunnel:

| Channel | Current boundary |
|---|---|
| Bridge-owned DSH phone view | Its protected project, conversation, prompt, live event, approval, directory, upload and download routes require encrypted request and response bodies over the tunnel. The computer's DSH still performs the work. URLs, cookies, timing, sizes and initial page/scripts remain visible. |
| Codex phone view | Covered real-time and content routes require application-layer encryption over the tunnel. The updated file browser sends local file paths inside encrypted POST bodies and receives encrypted bytes. This does not certify every possible route or the first page. |
| Original DSH view (`view=classic`) | Covered WebSocket events and outbound prompt/upload bodies are encrypted; the gateway now rejects unencrypted remote prompt/upload writes. Other DSH HTTP API and history **responses can still be plaintext** to the TLS-terminating relay. Use the bridge-owned phone view for the stronger content boundary. |

The gateway also requires proof of the fragment secret before serving protected HTTP or WebSocket content to a remote device. This reduces what someone can do with the access key from the URL path alone; it does **not** protect against a relay that can replace the page or redirect the browser. A successful device proof is temporarily retained by device ID, including across gateway restarts. A relay that obtains an already-proven device cookie may reuse that device's access window; do not treat proof as protection against a malicious relay. Protected requests reject missing or invalid encryption instead of silently forwarding plaintext. Testing is not a guarantee of complete coverage or security.

Rotating only the `#` fragment secret changes the content-encryption secret; it does **not** revoke the access-key path, existing device cookies, or an already-retained device proof. If the complete link, a cookie, or a device may be compromised, revoke that device and rotate the **access key** with session revocation. An older cached Codex page may send a file path in a GET URL before the updated gateway rejects it over a tunnel; reopen the updated phone page to use the encrypted POST route. Classic DSH API responses remain outside the content-encryption boundary described above.

On a local network, the HTTP entry point is plaintext; the optional local HTTPS entry point uses a local certificate that your device must validate appropriately. A direct Internet HTTP entry point is also plaintext. See [README.md](README.md) for the supported connection modes and their trade-offs.

This preview starts only Cloudflare tunnels; the old ngrok fallback is disabled. The gateway rejects local-console access and requires the remote encryption boundary when an incoming request has a public Host or forwarding headers, even if the socket peer is loopback. Arbitrary reverse proxies are not supported. If a proxy rewrites Host to a local address and removes every forwarding header, the gateway cannot distinguish its remote requests from requests made on the computer itself. Do not publish the gateway through such a proxy.

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
