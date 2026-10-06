# Third-party notices

Pocket Bridge's own source code is licensed under [MIT](LICENSE) and currently has no third-party npm dependencies. The Windows installer bundles third-party runtimes; their copyrights and licenses remain with their respective owners.

| Component | Purpose | License and included text |
|---|---|---|
| [Node.js](https://nodejs.org/) | Runs the local gateway | MIT and other included dependency notices; the complete distribution license is retained at `runtime/node-*/LICENSE`. |
| [cloudflared](https://github.com/cloudflare/cloudflared) | Optional remote tunnel client | Apache License 2.0; the complete license is retained at `cloudflared/LICENSE`. |

The Windows installer is built using [NSIS](https://nsis.sourceforge.io/Docs/AppendixI.html), a separate installer-building tool with its own licensing terms. Pocket Bridge does not claim authorship of NSIS, Node.js, or cloudflared. Keep the bundled Node.js and cloudflared license files with any redistributed installer or extracted package.

## Software not included

DeepSeek Harness (DSH) is **not bundled**. Install and configure it and the required model account separately. Pocket Bridge provides a local gateway and its own browser interface; it does not provide model access or a subscription. New installers are DSH-only. Historical combined installers are retained in GitHub Releases and are not updated.

## Names and attribution

Pocket Bridge is independent and unofficial. It is not affiliated with, sponsored by, or endorsed by DeepSeek, OpenAI, or Cloudflare. Their product names, as well as the names of optional notification providers, identify compatibility or a service used; all trademarks remain with their respective owners. No third-party logo or screenshot is included as a claim of endorsement.

A similarity check, when run, is only a limited text comparison. Passing it is not proof of non-infringement or a legal clearance. If you identify a specific licensing or attribution concern, please contact the maintainer using the appropriate non-public channel described in [SECURITY.md](SECURITY.md); do not post sensitive details publicly.

## Original artwork and DSH branding

The current Pocket Bridge mark, PWA icons, and Windows icons use original geometric artwork authored in `desktop/brand-artwork.js` and `pwa/pocket-bridge.svg`, licensed with this project's MIT source. They do not use the official DeepSeek whale, an external font, or a copied brand image.

DSH is named to accurately identify the connected software. DeepSeek's [brand asset guidelines](https://github.com/deepseek-ai/deepseek-harness/blob/master/BRAND_GUIDELINES.md) permit accurate descriptive references, recommend the DSH abbreviation, and warn against names or promotional material that suggest official endorsement. Its [MIT software license](https://github.com/deepseek-ai/deepseek-harness/blob/master/LICENSE) does not by itself clear every trademark, logo, or visual design use. These choices reduce avoidable confusion; they are not a blanket legal clearance.
