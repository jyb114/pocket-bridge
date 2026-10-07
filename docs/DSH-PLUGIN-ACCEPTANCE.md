# DSH plugin acceptance - Preview.13

This record describes actual operations on Windows during October 7, 2026.
The new plugin adds a local Settings panel to the existing lightweight phone
gateway. It is separate from the standalone gateway's historical acceptance.

## Operated hosts and transport

| Host | Installation and local controls | Encrypted HTTPS phone-sized browser |
| --- | --- | --- |
| Published npm DSH Web 0.1.7-rc.2 | Official CLI install and source upgrade; Settings Start, Refresh, diagnostics, Stop cancellation/confirmation, reveal/copy/hide and desktop controls. Cold host reload loaded the updated plugin. | Add a D: workspace, create a conversation, choose the Account model with Low reasoning, send a prompt and receive the actual response. |
| Published npm DSH Web 0.2.0-rc.2 | Official CLI install, upgrade and cold host reload; the same local controls. Official CLI removal unregistered the panel and returned authenticated HTTP 404 for its status route while DSH stayed running. | Add a workspace/conversation, select the model and receive an actual response. Preview/download a workspace file with identical bytes; upload a text attachment and receive the model's response after reading it. |
| Official native DSH 0.1.7-rc.2 | Install and enable through the original desktop plugin manager; native Settings Start, Stop, diagnostics, reveal/copy/hide and desktop-controls action. Remove and reinstall through the manager. Cold restart retained the plugin entry and allowed Start again. | Open the link from the native panel, add a workspace/conversation, choose the Account model and receive its real response. The existing conversation was present again after the host restart. |

The native test used the actual official Electron executable, its original
`dsh-app://app/` renderer and a separate test home/user-data directory. Browser
automation attached to that application's loopback debugging endpoint. It did
not substitute an npm page or a fake native-origin fixture for the desktop app.
The usual capture helper could not capture the original minimized window, so
native acceptance was completed through this isolated real application instead.

Phone checks used real headed Edge pages at **390 x 844** through temporary
Cloudflare HTTPS entrances, with the encrypted connection indicator present.
They were not physical iPhone/Android or cellular-network tests. The model route
was DeepSeek Account; an initial API-key route correctly reported unavailable
credentials and was not counted as a successful reply.

## Lifecycle and failure observations

- Existing unrelated bridge listeners were preserved. Each plugin used its own
  stable gateway directory and checked the listener identity and DSH target.
- Both npm DSH processes were actually stopped while their gateway processes
  stayed running. Health continued to name the original DSH port with
  `dshAlive=false`; it did not switch to the other installed native DSH. The same
  gateways and targets recovered after the npm hosts restarted.
- A real missing-cloudflared run produced a running local gateway with no ready
  HTTPS entrance. Adding the runtime to the owned installation and starting again
  enabled the connection. Local liveness was not reported as phone delivery.
- Stop required confirmation; Cancel left the gateway running. Confirming Stop
  closed the selected gateway listener while DSH stayed running.
- Real native operation exposed a stale-diagnostics defect: results from a previous
  unavailable entrance remained after a new running gateway became ready. The
  fix was reinstalled through the manager and operated again. Start/Stop cleared
  obsolete checks, ordinary polling retained current checks, and rerunning
  diagnostics displayed a check time for the new state.
- Connection details were hidden initially and after explicit Hide. Copy reported
  successful delivery to the clipboard. The two-minute automatic hide was also
  observed on a real npm panel. This display timeout is not key revocation.
- A screenshot of the real rendered 211 x 211 QR code was independently decoded
  with ZXing and matched the expected complete private URL. No external QR service
  received it. This is a rendered-code test, not camera acceptance.
- Native removal/reinstallation retained the test configuration, access key and
  encryption key byte for byte. npm 0.2.0-rc.2 removal retained configuration,
  both keys, installation identity, paired-device state and the actual 24-byte
  uploaded DSH attachment. Changes made later by normal startup are separate
  from this removal check.

## Package and isolated verification

An actual `npm pack --ignore-scripts` tarball was parsed independently, safely
expanded and passed 35 managed-installation checks. These included complete
public-file hash verification, real source upgrade, unchanged expanded source
and private-state preservation. Focused tests separately covered host admission,
native control tokens, gateway ownership, genuine Node discovery, stale
asynchronous UI results, secret display and package dependency closure.

The Windows release workflow packages the plugin outside the checkout, verifies
its identity and hash, and publishes its verification record and checksums beside
the installer and source archive. Its independent exact-commit CI gate remains
before packaging and is checked again before publication. Isolated PowerShell
workflow tests verify those boundaries; they are not GitHub publication evidence.

Private test transcripts, provider credentials, pairing URLs, QR screenshots,
runtime configuration and logs are kept outside the public checkout. The public
panel screenshot shows the actual isolated npm host with its connection hidden.
The separately captioned phone illustration uses synthetic demonstration data.

## Limits

This is exact-host, operation-specific acceptance, not complete desktop feature
parity or universal old/future-version support. Plugin-specific approval/question
round trips, physical-phone camera scans, native-host file transfer, mobile
Safari keyboard behavior and cellular networks were not covered by these plugin
checks. Earlier standalone-runtime acceptance remains separately documented.

The original desktop host emitted errors from its own plugin-event stream during
the first session; plugin installation and controls still operated. An isolated
forced application restart left an unusable old debugging listener. Its uncertain
ownership was preserved, and the next test instance used a separately verified
free loopback debugging port. Neither observation is presented as zero-error
native acceptance or as a reason to terminate production processes.

Protected content encryption does not authenticate a page actively replaced by
its serving provider. Providers still see connection metadata, and model services
receive submitted instructions. See [SECURITY.md](../SECURITY.md) and the
[plugin guide](DSH-PLUGIN.md) for requirements and trust boundaries.
