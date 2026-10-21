# Release notes - 1.0.0-preview.21

Show permitted conversation images without downloading each original first.
This preview adds small automatic thumbnails, an in-page original viewer,
and explicit original downloads while retaining encrypted content transport
and the existing file-authorization boundaries.

## Conversation images

Supported local Markdown image and file links become DOM image controls or
file actions. A model-generated link does not grant filesystem access and
is not turned into an unrestricted browser link. Remote image URLs are not
automatically fetched by this preview path.

Images close to the visible transcript request a JPEG thumbnail no larger
than 960 pixels on either side and 200 KiB. The Windows converter can reduce
the dimensions further to satisfy that byte limit. The page performs at most
two image reads at a time; each gateway runs one Windows conversion with a
bounded queue and timeout. A failed thumbnail leaves an error and retry or
explicit original action rather than silently downloading the full image.

Tap the image to open its original in the page, or choose **Download
original**. Raster originals remain limited to 8 MiB, 8,192 pixels per side
and 20 million pixels. The page holds bounded image blobs in memory and
releases object URLs and pending work when its connection or conversation
changes. The image view does not store these bytes in browser persistent
storage or the public asset cache. Explicit downloads and DSH's own files
have separate storage lifetimes.

## File authority and privacy

Official attachment IDs still go through DSH's session-authorized reader.
Local image paths must remain inside the conversation's real workspace,
or have an exact approval created by the local `approve-dsh-image.js` CLI.
That signed approval binds the gateway instance, session, canonical workspace
and file, file identity and SHA-256, and expires after 24 hours. It grants
one exact raster, not directory access. Approval is checked again before
returning bytes, including after conversion or a cache hit. Concurrent local
registry updates are serialized to avoid restoring a successfully revoked
grant. Model text and phone requests cannot create approvals.

Image requests and responses use the existing authenticated encrypted content
path. A passive tunnel receives ciphertext for these routes, while metadata
and the initially delivered application retain the trust limits described in
[Security](SECURITY.md). Revocation blocks later server reads; it cannot
recall bytes that a recipient has already received or downloaded.

## Other interaction fixes

Clear stale goal state, release resources retained by closed dialogs, and
cancel temporary previews that no longer belong to an unsent attachment.
Invalid image references display a local failure without interrupting the
remaining conversation. Existing compact controls and backup-address
preferences remain available.

Keep the verified update action at the bottom of the viewport so the
separate code-mismatch warning cannot cover its button. The warning remains
visible and all verification and explicit update requirements remain intact.
Changes confined to either new image module also trigger version detection.

## Verification and release boundaries

The actual candidate interface was operated against **DSH 0.2.1-rc.2** in a
**390 by 650 desktop-browser phone viewport**. A tool image from a real DSH
session loaded automatically and opened its original in the page. Through a
real temporary HTTPS tunnel, two explicitly approved local Markdown images
also loaded automatically on scrolling, without clicking: each original was
about 3 MB and each encrypted thumbnail response about 90 KB. An explicit
original download retained all 3,248,931 bytes and matched the source SHA-256.
The dedicated QA conversation also accepted a real instruction and returned
its requested short reply. Plaintext requests to both new image routes were
rejected. These operated checks do not certify every image, format or path.

Separate isolated tests exercise the production request entry, authenticated
AES wrapping, session and hash checks before conversion, malformed and
oversized images, cancellation, workspace escapes, signed approval expiry
and revocation, and concurrent approval updates. Native Windows thumbnail
conversion is tested separately from mocked transport results. These checks
are not physical iPhone/Android, cellular, final-installer or old npm-host
acceptance. The new image feature has not been rerun on the historical npm
hosts; exact host admission and compatibility claims are unchanged. Final
packaging, installation and a production recheck remain separate release
gates. See the [compatibility matrix](docs/DSH-COMPATIBILITY.md) and historical
[Preview.20 acceptance](docs/PREVIEW20-ACCEPTANCE.md).

npm publication remains deferred pending authorization for the intended npm
account and package name. DSH login is separate from npm authorization. A
prepared package, local test index or community website listing does not
establish public npm-backed Discover availability. Read the
[distribution instructions](docs/DSH-PLUGIN.md#preparing-an-npm-distribution).

Personal notification scripts, account details and private connection
material are excluded from public source and distribution artifacts.
