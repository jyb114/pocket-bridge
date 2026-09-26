# Third-party notices

Pocket Bridge's own source code is licensed under [MIT](LICENSE) and currently has no third-party npm dependencies. The Windows installer bundles third-party runtimes; their copyrights and licenses remain with their respective owners.

| Component | Purpose | License and included text |
|---|---|---|
| [Node.js](https://nodejs.org/) | Runs the local gateway | MIT and other included dependency notices; the complete distribution license is retained at `runtime/node-*/LICENSE`. |
| [cloudflared](https://github.com/cloudflare/cloudflared) | Optional remote tunnel client | Apache License 2.0; the complete license is retained at `cloudflared/LICENSE`. |

The Windows installer is built using [NSIS](https://nsis.sourceforge.io/Docs/AppendixI.html), a separate installer-building tool with its own licensing terms. Pocket Bridge does not claim authorship of NSIS, Node.js, or cloudflared. Keep the bundled Node.js and cloudflared license files with any redistributed installer or extracted package.

## Software not included

DeepSeek Harness (DSH) and OpenAI Codex are **not bundled**. To use their respective features, install and configure the corresponding computer-side software and accounts separately. Pocket Bridge only provides a local gateway and browser interface. It does not provide DSH, Codex, model access, or a ChatGPT subscription. Their availability, license terms, and fees are determined by their respective providers. In particular, using the Codex integration does not mean Pocket Bridge includes or replaces the ChatGPT desktop app.

## Names and attribution

Pocket Bridge is independent and unofficial. It is not affiliated with, sponsored by, or endorsed by DeepSeek, OpenAI, or Cloudflare. Their product names, as well as the names of optional notification providers, identify compatibility or a service used; all trademarks remain with their respective owners. No third-party logo or screenshot is included as a claim of endorsement.

A similarity check, when run, is only a limited text comparison. Passing it is not proof of non-infringement or a legal clearance. If you identify a specific licensing or attribution concern, please contact the maintainer using the appropriate non-public channel described in [SECURITY.md](SECURITY.md); do not post sensitive details publicly.
