'use strict';
// Execute only the helper's pure identity predicates, never its GUI actions.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { safeForegroundDiagnostic, safeModifierDiagnostic } = require('./codex-desktop-driver.js');
const privateContext = { foregroundHandle: '42', foregroundRootHandle: '40', boundWindowHandle: '40',
  foregroundProcessId: 123, foregroundRootProcessId: 123, boundProcessId: 123, elapsedMs: 100,
  identityCopyKind: 'thread', identityCopyPhase: 'after-shortcut' };
assert.deepEqual(safeForegroundDiagnostic({ ...privateContext, prompt: 'never retain this', title: 'private title' }), privateContext);
assert.equal(safeForegroundDiagnostic(null), null);
assert.equal(safeForegroundDiagnostic([]), null);
for (const change of [
  { foregroundHandle: 'private title' }, { foregroundHandle: '42\n' }, { boundWindowHandle: 40 },
  { foregroundProcessId: -1 }, { foregroundProcessId: '123' }, { elapsedMs: Infinity },
  { identityCopyKind: 'prompt text' }, { identityCopyPhase: 'clipboard text' }
]) assert.equal(safeForegroundDiagnostic({ ...privateContext, ...change }), null);
console.log('PASS 11 private foreground diagnostic boundary checks; no desktop actions.');
const releasedModifiers = Object.fromEntries(['shift', 'control', 'alt', 'leftShift', 'rightShift', 'leftControl',
  'rightControl', 'leftAlt', 'rightAlt', 'leftWin', 'rightWin'].map(key => [key, false]));
assert.deepEqual(safeModifierDiagnostic({ ...releasedModifiers, text: 'must be omitted' }), releasedModifiers);
assert.deepEqual(safeModifierDiagnostic({ ...releasedModifiers, leftWin: true }), { ...releasedModifiers, leftWin: true });
for (const change of [null, [], {}, { ...releasedModifiers, alt: 'false' }, { ...releasedModifiers, control: 0 }])
  assert.equal(safeModifierDiagnostic(change), null);
console.log('PASS 7 private modifier diagnostic boundary checks; no desktop actions.');
if (process.platform !== 'win32') {
  console.log('SKIP Windows PowerShell desktop mode identity checks on non-Windows.');
  process.exit(0);
}
const script = fs.readFileSync(path.join(__dirname, 'codex-desktop-ui.ps1'), 'utf8');
const start = script.indexOf('$script:ChineseModePrefix =');
const end = script.indexOf('\nfunction Fail-Relay', start);
assert(start >= 0 && end > start, 'Pure mode predicates must be available.');
const modeCases = [
  ['Switch mode, current mode: Codex', 'codex'],
  ['Switch mode, current mode: ChatGPT', 'chatgpt'],
  ['Switch mode, current mode: ChatGPT Work', 'chatgpt'],
  ['切换模式，当前模式：Codex', 'codex'],
  ['切换模式，当前模式：ChatGPT', 'chatgpt'],
  ['切换模式，当前模式：ChatGPT Work', 'chatgpt'],
  ['', null], [null, null], ['Codex', null], ['ChatGPT', null],
  ['Switch mode, current mode: codex', null],
  ['Switch mode, current mode: Codex Beta', null],
  ['Switch mode, current mode: Codex ', null],
  ['Switch mode, current mode: Codex\n', null],
  ['Switch mode, current mode: ChatGPT Your dot', null],
  ['切换模式，当前模式：Your dot', null],
  ['切换模式，当前模式：Codex Beta', null],
  ['切换模式，当前模式：Codex ', null],
  ['切换模式，当前模式：Ｃodex', null]
];
const menuCases = [
  ['Codex Build, debug, and ship', true],
  ['Codex 构建、调试和发布', true],
  ['', false], [null, false], ['Codex', false], ['Codex Beta', false],
  ['ChatGPT Create, learn, and explore', false],
  ['ChatGPT Work Create, learn, and explore', false],
  ['ChatGPT 创建、学习和探索', false],
  ['Your dot', false], ['Codex 构建、调试和发布 ', false],
  ['Codex Build, debug, and ship\n', false]
];
const id = '01a0f742-ccc7-7d62-aa04-ebe22ac131a0';
const link = 'codex://threads/' + id;
const linkCases = [
  [link, id], ['codex://threads/' + id.toUpperCase(), id],
  ['', null], [null, null], [id, null], [link + '/', null], [link + '?', null],
  [link + '?view=review', null], [link + '#', null], [link + '#secret=value', null],
  [' ' + link, null], [link + ' ', null], [link + '\n', null], [link + '\r\n', null],
  ['CODEX://threads/' + id, null], ['codex://Threads/' + id, null],
  ['codex://user@threads/' + id, null], ['codex://threads:123/' + id, null],
  ['codex:///threads/' + id, null], ['codex://threads//' + id, null],
  ['codex://threads/%30' + id.slice(1), null], ['codex://threads/' + id.replace('-', '%2d'), null],
  ['https://chatgpt.com/c/' + id, null], [link.replace('threads', 'threads.evil'), null],
  ['codex://threads/' + id.slice(0, -1) + 'g', null], [link + '\u0000', null]
];
const fixtures = Buffer.from(JSON.stringify({ modes: modeCases, menus: menuCases, links: linkCases }), 'utf8').toString('base64');
const command = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false);\n" +
  script.slice(start, end) + '\n' +
  "$data=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + fixtures + "')) | ConvertFrom-Json;\n" +
  '$results=@(); foreach($case in $data.modes){$results += [pscustomobject]@{kind=(Get-DesktopModeKind $case[0])}}; ' +
  'foreach($case in $data.menus){$results += [pscustomobject]@{match=(Test-DesktopCodexMenuName $case[0])}}; ' +
  'foreach($case in $data.links){$results += [pscustomobject]@{threadId=(Get-ThreadIdFromDesktopDeepLink $case[0])}}; ' +
  '[Console]::Out.WriteLine(($results | ConvertTo-Json -Compress));';
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
  Buffer.from(command, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
assert.equal(result.status, 0, result.stderr || 'Pure mode checks failed.');
const outputs = JSON.parse(result.stdout.trim().replace(/^\uFEFF/, ''));
assert.equal(outputs.length, modeCases.length + menuCases.length + linkCases.length);
modeCases.forEach(([name, expected], i) => assert.equal(outputs[i].kind, expected, 'Exact mode identity: ' + JSON.stringify(name)));
menuCases.forEach(([name, expected], i) => assert.equal(outputs[modeCases.length + i].match, expected, 'Exact Codex menu identity: ' + JSON.stringify(name)));
linkCases.forEach(([name, expected], i) => assert.equal(outputs[modeCases.length + menuCases.length + i].threadId, expected,
  'Strict desktop conversation link: ' + JSON.stringify(name)));
console.log('PASS ' + outputs.length + ' actual PowerShell mode, menu and deep-link identity checks; no desktop actions.');
require('./test-codex-desktop-layout.js');
require('./test-codex-desktop-placeholder.js');
require('./test-codex-desktop-text.js');
require('./test-codex-desktop-lifecycle.js');
