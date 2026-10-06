# DSH compatibility and actual test coverage

Updated 2026-10-05. New Bridge releases focus on DSH. Earlier GitHub installers remain historical releases; their Codex or Dot features are not part of the new DSH-only runtime.

Version detection selects an adapter after checking the local runtime and its observed protocol. A recognized version, a running service, or a successful automated fixture is not proof that every feature works. The exact distribution and the operated workflow matter.

## Desktop baseline

The current Windows desktop baseline is **DSH 0.1.7-rc.2**, detected from its installed desktop package. Actual authenticated reads returned its session list, model catalog, presets and permission projection. Those read-only checks do not accept message delivery, uploads, approvals or every desktop state. Fresh public-browser operations for the release are recorded separately in [Manual acceptance](MANUAL-ACCEPTANCE.md).

The original desktop application on the lost laptop has not been identified or tested. Old npm web packages do not establish compatibility with that executable, another desktop wrapper or an Electron IPC-only build.

## Real npm web tests

These are **historical actual operations from 2026-10-01**, using published `@deepseek-ai/dsh` packages in separate D-drive homes and workspaces. The tester used real Edge/Chrome pointer and keyboard interaction at a 390-pixel mobile viewport, through Bridge authentication and encryption. The DSH RPCs and successful model replies were not mocked. These tests have not all been repeated against the current DSH-only candidate.

“Passed” below applies only to the stated operation. “Unverified” means the required result was not observed.

| Exact npm web version | Protocol profile | Actual operations that passed | Model response | Questions and tool approvals | Remaining limits |
| --- | --- | --- | --- | --- | --- |
| **0.1.0-rc.8** | `legacy-events` | Project creation, two conversations, workspace file listing and text preview, a saved download matching its source bytes, and a Bridge-staged image receipt; 10 bounded checks. | **Unverified.** No valid API key was available. Earlier real sends returned upstream `AUTH401`. | Pending-interface reads worked; no real model-triggered question, choice or approval round trip passed. | The staged image was not sent to a model. Successful reasoning and image-message completion remain unverified. |
| **0.1.1-rc.2** | `legacy-events` | The same bounded project, two-conversation, file/download and staged-image operations; 10 checks. | **Unverified**, with the same valid-API-key limitation. | No completed real model-triggered question or approval round trip. | The staged image was not sent to a model; successful reasoning remains unverified. |
| **0.1.7-rc.2** | `remote-mux` | Project creation, two conversations, workspace file/download, official upstream image receipt, image message and an actual assistant reply; 12 checks. | **Passed** after selecting the visible DeepSeek Account provider. | Questions and tool approval round trips remain **unverified**. | The default API-key provider had no key. This npm result is separate from the desktop distribution. |
| **0.2.0-rc.2 CLI web** | `remote-mux` | The same project, two-conversation, reply, file/download and image operations, plus a real displayed question answered from the phone layout; 14 checks. | **Passed** after selecting the account provider. | **Question/answer passed.** A tool approval card appeared in a separate experiment, but allow/reject was not operated. | Only this exact CLI web version was admitted after authenticated events and workspace-baseline verification. Other 0.2 builds and desktop wrappers are unverified. |

An upstream authentication failure remains a failure. A later successful run does not convert the earlier `401` or download timeout into a pass. A displayed approval card is not proof that its response was accepted. A staged attachment is not a delivered image message.

## Installation and device limits

The older prepared npm installations used matching DSH peer packages and compatible Cordis dependency pins. Official package files were not patched. The old test setup used `--legacy-peer-deps` and pinned these Cordis packages to the lower-bound versions declared by the old manifests: `cordis@4.0.1`, `cordis-plugin-group@1.0.1`, `cordis-plugin-hmr@1.0.16`, `cordis-plugin-include@1.0.6`, `cordis-plugin-loader@1.0.2`, and `cordis-plugin-timer@1.1.3`, all under the `@deepseek-ai` scope.

This is not acceptance of today's fresh, unmodified `npx @deepseek-ai/dsh@<old-version> web` installation. Successful installation and full model compatibility remain separate questions. New-format account grants are not a substitute for the legacy API-key credential format. Generic text-file upload is unsupported by the inspected legacy image wire.

The four npm runs used local mobile-sized desktop browsers. They did **not** test physical iPhone Safari, Android, mobile 5G or Cloudflare tunnels. Current desktop public-route acceptance does not fill those old-version device/network gaps. Permissions, slash commands, goals, cancellation and newer UI fixes require their own actual-version acceptance; schema inspection or isolated fixtures alone do not certify them across all versions.

The inspected **0.1.5-rc.3** mapping is `remote-mux`, but no actual npm workflow acceptance for that version is recorded here. Unknown future versions and uninspected wrappers are not supported solely because their version string resembles a tested release.

## Traceable evidence

The private D-drive audit directory `legacy-real-acceptance-20261001` retains the run reports and screenshots. They are excluded from the repository and installer because they can contain private runtime/session details. The following report names and SHA-256 hashes identify the exact historical records reviewed for this matrix; they are provenance references, not downloadable public evidence.

| Record under that audit directory | SHA-256 |
| --- | --- |
| `ACTUAL-ACCEPTANCE-SUMMARY.json` | `672ffe0c7d324a5a4767f12ae69ef33a2f9a73cb6657de6c7984c886d5c61f13` |
| `0.1.0-rc.8-1790869536780/result.json` | `08f4b873dac618ee7e00977f33c7f726d7d515bb24a1bd20470ade0518c839a9` |
| `0.1.1-rc.2-1790869614868/result.json` | `442772a836e66e54cc33ea68f05a3923c49d34138deefd7236de555afcc1b940` |
| `0.1.7-rc.2-1790870378983/result.json` | `2fe811aa3927c33960b4f24f4d28c684fd74c7b83c58f428643c824301967854` |
| `0.2.0-rc.2-1790870621626/result.json` | `8f8ae95dd7651159f8d8f0264e2a8b9415a07a8e552ae6f7cf73a84ad8ff720c` |

Each per-run report records the installed version, actual-runtime and actual-browser flags, operations performed, confirmation flags, and the explicit physical-phone/tunnel exclusions. The older D-drive `dsh-real-use-20260929/LEGACY_SETUP.md` records the prepared dependency graph and the earlier authentication limitation. [Manual acceptance](MANUAL-ACCEPTANCE.md) preserves both the earlier failures and later bounded successes. [SECURITY.md](../SECURITY.md) defines transport coverage and the initial-page trust boundary; compatibility tests are not a security certification.
