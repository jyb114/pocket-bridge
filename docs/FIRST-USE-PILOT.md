# First-use pilot: Windows + DSH + a real phone

Pocket Bridge is a DSH-only developer preview. This checklist helps you establish what works on **your** computer, runtime, phone, and network. A passing automated test or a screenshot is not a substitute for these checks.

## Before you start

- Use Windows x64 and a separately installed, signed-in DeepSeek Harness (DSH).
- Open a harmless test project in DSH and confirm that it replies locally first.
- Install a verified DSH-only preview from [Releases](https://github.com/jyb114/pocket-bridge/releases). The README links a specific preview; check its release notes and checksums.
- Keep the host computer awake and connected. Model access and provider fees are separate.
- Use a test workspace without private documents. Read [SECURITY.md](../SECURITY.md).
- Current evidence is version-specific. Check the [compatibility matrix](DSH-COMPATIBILITY.md) and [mobile acceptance record](DSH-MOBILE-ACCEPTANCE.md); physical-phone and cellular coverage remains incomplete.

## One small first session

1. Open Pocket Bridge's local desktop console. Check that it detects the intended DSH runtime.
2. Copy the **complete HTTPS phone link** from that console. Keep its access key and `#k=` fragment private.
3. Open it in your phone browser. Ordinary LAN HTTP is not a supported substitute: phone content needs a secure context and browser WebCrypto.
4. Select the harmless test project and a conversation, or create one.
5. Send a simple message that does not request file changes. Confirm that your message and a corresponding reply appear.
6. Record whether it succeeded, approximately how long setup took, and the last completed step if it failed.

A complete connection URL may grant access. Never put it in an issue, screenshot, social post, or public video.

## Optional follow-up checks

Run these only after the first reply works and only when relevant to your own use:

- **Reconnect:** leave and reopen the page; confirm the intended conversation and history return. If delivery is uncertain, check the history before retrying an instruction.
- **Approvals:** for a harmless action that naturally requires approval, check the request, your choice, and the resulting runtime state. Never approve a destructive action just to test the interface.
- **Files:** try previewing or downloading one non-sensitive file inside the permitted test workspace. Distinguish an opened preview from an actually saved file.
- **Your normal network:** repeat the basic conversation on the network you intend to use. Wi-Fi success alone does not establish cellular success.
- **Return use:** on another day, note whether you used the bridge for an actual task and what got in the way.

Capabilities depend on the runtime. An unavailable feature is not proof of a successful operation.

## If something fails

| Symptom | First check |
| --- | --- |
| DSH is not detected or cannot reply | Confirm DSH itself works locally and compare the reported version with the compatibility matrix |
| A previously working phone link stops opening | Check that the host is awake and the tunnel is connected; copy the current complete link from the local console |
| Encryption or authorization fails | Check that the complete link and fragment were retained; do not remove protection or fall back to plain HTTP |
| Send result is uncertain | Inspect conversation history before sending again; include the redacted error in a report |
| A control or file operation is unavailable | Record the runtime version and exact operation; avoid assuming support across versions |

Temporary tunnel addresses may change after restarting. Network failures do not establish that an instruction was accepted.

## Report a result safely

[Open a GitHub issue](https://github.com/jyb114/pocket-bridge/issues/new) with the following information, only as much as you are comfortable sharing:

- Pocket Bridge version
- Windows version and DSH version/package or wrapper
- Phone OS and browser version
- Connection type: trusted local HTTPS, temporary tunnel, or configured private HTTPS; Wi-Fi or cellular
- Last successful checklist step
- Expected result and actual result
- Minimal reproduction steps and a redacted error, if any
- Approximate setup time and whether a first reply arrived
- Optional: whether you came back on a different day

Do **not** include credentials, access keys, complete connection URLs, private transcripts, private project paths, or unredacted screenshots. Report sensitive security findings using [SECURITY.md](../SECURITY.md), not a public issue.

No user count, device coverage, or compatibility result is inferred from downloads or stars. Feedback is voluntary; this document does not introduce telemetry.
