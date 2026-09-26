# Changelog

## 1.0.0-preview.2 — Windows preview

- Prepared a Windows x64 installer for the local gateway, with bundled Node.js and cloudflared. The installer is unsigned; Windows may display a reputation warning.
- Added first-run generation of local access and encryption secrets. DSH and Codex themselves are not included and must be installed and configured separately on the computer.
- Added phone-browser access, a local connection option, an optional temporary Cloudflare tunnel, device controls, and Codex session viewing and interaction.
- Improved the computer console's pairing-code display and connection guidance. A pairing code is not a substitute for the complete connection URL.
- Added a choice between queuing a Codex instruction and sending it into a running turn. If the turn cannot be confirmed, the instruction is saved to the queue only after the save succeeds.
- Added separate controls for releasing a phone-held Codex conversation and taking over a desktop-held one; the desktop action can interrupt work and is marked as hazardous.
- Added automatic phone-side handback after all Codex phone connections remain closed for about 60 seconds. This is not an instantaneous page-close operation.
- Made Codex voice recognition follow the selected interface language and hid runtime child-process console windows on Windows.
- Kept automatic proxy configuration scoped to the Pocket Bridge-managed Codex process. Changing Windows user-wide proxy variables remains an explicit, warned troubleshooting action.
- Added isolated source-install and packaging checks. Passing checks does not guarantee compatibility with every DSH/Codex version, phone, network, or notification provider.

This preview has **no Linux or macOS installer**. Temporary tunnel addresses can change or become unavailable; notifications may not arrive. Application-layer encryption covers only the channels described in [SECURITY.md](SECURITY.md). The project is independent of DeepSeek, OpenAI, and Cloudflare.
