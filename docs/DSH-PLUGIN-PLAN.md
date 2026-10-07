# DSH plugin implementation and acceptance plan

This work adds a local DSH entry point for Pocket Bridge. The existing lightweight phone application, encryption and authorization remain the content transport. It does not expose the original DSH interface through a public tunnel.

## Deliverables

1. Package a DSH bundle with a Pocket Bridge settings page. Reuse an existing bridge installation when explicitly configured; otherwise use the bundle's included gateway source. No provider account or additional hosted service is introduced.
2. Provide separate gateway, DSH and internet-connection status. Reveal the complete private phone link only after an explicit action, and generate its QR code locally. Clear revealed credentials on connection changes, disposal and failures.
3. Provide real start, pause, local desktop controls and bounded diagnostics. Commands are limited to the selected bridge installation and its verified current gateway boot. Pausing the bridge must not stop DSH or its tasks.
4. Package an installable GitHub tarball. Validate its contents, install it into isolated real DSH environments, operate every visible control, uninstall it and restart the host. State the exact versions and untested boundaries.

## Comparison priorities

- First connection should explain what is running, what is missing and what to do next.
- A tunnel process and a working public entrance are different states. Unknown reachability must remain unknown.
- Slow or disconnected requests need bounded waiting, a visible retry path and preserved phone drafts. Never automatically retry an uncertain instruction.
- Keep the existing small phone interface and explicit image loading. Do not load the original desktop application merely to show a connection panel.
- No external QR service, remote fonts, central account, telemetry or third-party announcement feed.
- Avoid a second gateway when an existing installation is selected. Treat a different DSH target as a configuration mismatch rather than silently showing another project's connection.

Public competitor documentation and issue reports are comparison evidence. They do not establish that we have personally run a competitor's software.

## Safety and validation

- DSH's host authentication remains required. Sensitive plugin HTTP routes additionally require a direct loopback socket, literal loopback Host, the actual host port and no relay headers. Browser writes require strict same-origin checks. The native carrier, which removes Origin, must also supply a per-host control token obtained from an authenticated local status read. A token must never override a conflicting Origin. No CORS exemption or RPC authority shortcut.
- Normal status responses and diagnostics contain no access links, keys, provider credentials, transcripts, notification settings, device lists or raw logs. Connection responses are local-only, explicitly requested and never cached.
- Verify the bridge installation UUID, gateway service, listener port, PID and boot identity before reading connection data or accepting a stop. Abort on identity changes or foreign listeners.
- Do not kill native applications, remove locks, change global Node/npm settings or import private notification scripts.
- Run focused source, lifecycle, HTTP-boundary, packaging and client tests; then use a real browser against real isolated DSH installations. Keep those results separate from physical-phone and desktop-app acceptance.
- Keep test homes, npm caches, browser profiles and evidence on D:. Preserve the running production gateway and DSH while developing.

## Initial test targets

Installed npm DSH `0.1.7-rc.2` and `0.2.0-rc.2` are the initial plugin-host candidates. API inspection is not acceptance. Desktop app support and historical phone-protocol support will be recorded separately; no blanket compatibility claim will be made.

## Distribution

Keep the Windows installer available. A plugin tarball offers an additional entry point. After successful acceptance, prepare the community catalog metadata and submit it through the catalog's current contribution process, with an accurate English description and version scope.

Private runtime files, connection URLs, credentials, uploads and the personal notification helper must never enter the plugin package or a public contribution.
