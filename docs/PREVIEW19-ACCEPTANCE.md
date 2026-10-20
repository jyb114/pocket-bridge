# Preview.19 distribution acceptance

Recorded 2026-10-20. This separates real operated workflows from isolated
regressions and from public distribution availability.

## Real npm host and plugin operations

The host was the official npm **DSH Web 0.2.1-rc.2**, running on Windows in a
separate D-drive home and browser profile. The host package was unmodified.
No diagnostic observer was loaded for this Preview.19 round. The previous
profile's own browser authentication was reused through the ordinary UI.

The real interface was used to open Plugins, inspect the existing plugin,
confirm uninstall, select Discover and switch to an explicitly labelled
local validation index. The candidate detail and confirmation named
`pocket-bridge@1.0.0-preview.19` and the loopback test registry. DSH's own
pnpm operation downloaded the actual candidate archive, reported installation
complete and enabled the component. All **186 installed archive members**
were compared byte for byte with the verified candidate.

This installation preceded the editor-focus correction described below and
the addition of this acceptance document. Its 186-member archive is not
presented as byte-identical to the final release package.

The Settings > Pocket Bridge panel opened successfully. Start upgraded its
stable managed gateway source from Preview.18 to Preview.19. Refresh confirmed
that gateway running; Stop was confirmed through the visible control. Hashes
of its existing access key, encryption key, installation identity and private
configuration were unchanged after real uninstall, reinstall and startup.
The production DSH and production gateway were separate from this profile.

The local index/registry are test fixtures serving real package bytes; they
are not a public npm listing. No DSH host, installation outcome or provider
reply was replaced with a simulated successful response.

## Real HTTPS phone-view operations

A separate desktop Edge browser used the real production Quick HTTPS
entrance at **390 by 650 pixels**. Production was still the installed
Preview.18. These live observations preceded the Preview.19 editor-focus fix.
This is not presented as a compiled Preview.19 installer acceptance.

Through the visible controls, the browser added an existing isolated
computer folder, created a conversation, selected the account-provided
DeepSeek-V4.1-Flash model and Low reasoning, and received the actual
`PB19_TUNNEL_OK` reply. A local text file was uploaded and sent. The DSH
history recorded the real read tool and its file content, followed by the
requested `PB19_FILE_READ_OK` model reply.

Reload restored the selected conversation and completed replies. The measured
transcript height was **492 px** and resting composer **105 px**. A long unsent
draft kept a **414 px** transcript and a bounded **116 px** input, without
horizontal overflow; that draft was cleared. These are observations from one
desktop-browser phone viewport, not physical iPhone/Android, keyboard or
cellular-network acceptance. They establish neither universal performance
bounds nor complete coverage of every button and optional runtime plugin.

## Isolated regression checks

The complete current isolated CI run passed **135 suites**, with six live-only
segments explicitly excluded from the passing count. The first-load banner
test now advances each fixture's own clock, retaining strict fast-load,
visibility and removal checks. Ten independent repeats passed, and three
in-memory regressions were rejected: missing readiness polling, retained
faded nodes and early slow-load notification. Production banner code was not
changed.

Release rechecking exposed a real delayed-focus race. In isolated Chromium,
the user clicked and selected all queued-message text before the editor's
pending focus callback ran. That callback collapsed the selection to the
end, so replacement text appended to the old message. The inline-goal
callback also selected a partially typed draft. Both original callbacks
were reproduced with actual browser pointer and keyboard input. The fix
respects an already focused control while retaining automatic focus for
untouched editors; strict text-retention assertions are not weakened.
The resulting 201-check browser suite passed three independent repeats.
Four in-memory negative variants were rejected: removing either editor's
user-focus protection or disabling either editor's untouched auto-focus.

The explicit npm distribution mode keeps the source package marked
`private: true` in the public repository and
makes only the verified package stage publishable. Package, controller,
managed-installation and publication-workflow checks remain separate from
real UI evidence. A successful npm publication dry run does not establish
account authorization or name ownership.

## Distribution and compatibility limits

The community public Discover index previously returned no Pocket Bridge
search result while its website offered the Preview.18 GitHub tarball.
Actual public Discover availability still requires npm account authorization,
package-name permission, a real npm publication and an index refresh. Source
publication and a Windows release do not substitute for those steps.

Admitted DSH versions are unchanged. Historical older-npm operations remain
in the compatibility record; they were not all repeated in this round.
Personal notification automation and account configuration are kept outside
the public repository, archives and installer.
