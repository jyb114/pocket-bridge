# Changelog

## Unreleased — Windows preview (1.0.0)

- Prepared a Windows x64 installer for the local gateway, with bundled Node.js and cloudflared. The installer is unsigned; Windows may display a reputation warning.
- Added first-run generation of local access and encryption secrets. DSH and Codex themselves are not included and must be installed and configured separately on the computer.
- Added phone-browser access, a local connection option, an optional temporary Cloudflare tunnel, device controls, and Codex session viewing and interaction.
- Improved the computer console's pairing-code display and connection guidance. A pairing code is not a substitute for the complete connection URL.
- Added isolated source-install and packaging checks. Passing checks does not guarantee compatibility with every DSH/Codex version, phone, network, or notification provider.

This preview has **no Linux or macOS installer**. Temporary tunnel addresses can change or become unavailable; notifications may not arrive. Application-layer encryption covers only the channels described in [SECURITY.md](SECURITY.md). The project is independent of DeepSeek, OpenAI, and Cloudflare.
