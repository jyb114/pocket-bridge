# Release notes - 1.0.0-preview.16

## DeepSeek-V4.1-Flash-1017 and the current desktop host

Recognize the verified native Windows DSH 0.2.1-rc.2 host and admit that exact
version through the optional plugin's engine and peer gates. Unknown versions
still require verification. Model selection continues to use the host's catalog;
Pocket Bridge does not substitute a different provider or rewrite model streams.

DeepSeek recommends Harness 0.2.1-rc.1 or newer for Flash-1017. The Windows
installer includes Pocket Bridge, Node.js and cloudflared, not DSH itself.
Earlier npm/desktop acceptance records are historical and do not establish
current Flash-1017 support in those hosts or complete cross-version parity.

## Safer mobile sending and recovery

The modern adapter prepares a request identity before dispatch. The computer
persists an exclusive dispatch decision and receipt metadata without saving
prompt plaintext. Reloading, reconnecting or moving to a prepared alternate
entrance does not automatically resend an uncertain task. Confirmed receipts
can be recovered without another DSH prompt. Revoked devices, changed encryption
keys, storage errors and conflicting request identities fail closed.

The phone distinguishes received, not dispatched and uncertain requests. An
accepted matching draft can be cleared without resending. A user can also
explicitly keep an intentional new identical question. An uncertain result
requires checking history and the queue before allowing a separate new message.
That separate operation can still duplicate a task whose earlier outcome is
unknown: this is not an exactly-once guarantee across all user actions.

Receipt recovery follows the existing authenticated device identity. Preparing
another entrance preserves that identity; independently pairing a new device
does not inherit another device's receipts. Older legacy adapters keep their
manual review barrier and do not gain the modern receipt protocol.

## Faster recovery, stable drafts and private diagnostics

- Preserve unsent text and uploaded attachment receipts during same-page list
  refresh and reconnect. Fence delayed history, selection and reconnect results
  to their original conversation and connection.
- Capture screenshots asynchronously with one owned capture at a time, bounded
  deadlines and close-before-cleanup. This prevents capture subprocess waits
  from blocking unrelated gateway HTTP work.
- Monitor the other verified tunnel while the authenticated page is visible,
  including after dismissing a reminder. Coalesce address changes, invalidate
  old preparation state and back off failed metadata reads.
- Require explicit browser preparation for each new alternate hostname. Copy
  only a credential-free address; do not navigate or send automatically.
- Redact complete spaced Windows/UNC paths and configured notification targets,
  including supported self-hosted ntfy/Bark servers, from diagnostic exports.
  Review any diagnostic file before publishing it.

Both tunnels still share the computer, gateway, network and Cloudflare. Browser
background suspension, a shared outage and changed hostnames remain real limits.
The content-encryption boundaries and initial-page trust limits remain described
in SECURITY.md. Personal notification configuration is not part of this release.

## Validation scope

See docs/DSH-COMPATIBILITY.md and docs/MANUAL-ACCEPTANCE.md for exact operated
versions and workflows. Automated protocol and fault-injection fixtures are
reported separately from original desktop UI, live mobile-sized browser and
public HTTPS tunnel operations. A desktop browser viewport is not a physical
iPhone, Android handset or cellular-network certification.

The previous release assets remain available. Upgrades preserve local identity,
configuration, devices, uploads and existing journals; no older GitHub release
or installer is removed.
