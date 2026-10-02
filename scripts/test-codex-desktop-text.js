'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { normalizeComposerText, verifyComposerTextProof } = require('./codex-desktop-text.js');
const cases = ['plain text', 'real newline\n', 'two real newlines\n\n', 'spaces  \n', 'Unicode 🦀\r\nsecond line\n', '\n'];
function proof(text) {
  const bytes = Buffer.from(normalizeComposerText(text), 'utf8');
  return { version: 1, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), utf8Bytes: bytes.length };
}
for (const text of cases) {
  const valid = proof(text);
  assert.deepEqual(verifyComposerTextProof(valid, text), valid);
  for (const invalid of [null, [], { ...valid, sha256: '0'.repeat(64) }, { ...valid, sha256: valid.sha256 + '\n' },
    { ...valid, utf8Bytes: valid.utf8Bytes + 1 }, { ...valid, version: 2 }, { ...valid, text }, { ...valid, sha256: valid.sha256.toUpperCase() }])
    assert.equal(verifyComposerTextProof(invalid, text), null);
}
assert.notDeepEqual(proof('text'), proof('text\n'));
assert.notDeepEqual(proof('text\n'), proof('text\n\n'));
assert.notDeepEqual(proof('text '), proof('text'));
assert.deepEqual(proof('text\r\n'), proof('text\n'));
if (process.platform === 'win32') {
  const source = fs.readFileSync(path.join(__dirname, 'codex-desktop-ui.ps1'), 'utf8');
  const start = source.indexOf('function Get-CopiedComposerTextProof(');
  const end = source.indexOf('\nfunction ', start + 1);
  assert(start >= 0 && end > start);
  const inputs = Buffer.from(JSON.stringify(cases.map(normalizeComposerText)), 'utf8').toString('base64');
  const command = "$ErrorActionPreference='Stop';[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false);\n" +
    source.slice(start, end) + "\n$cases=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + inputs + "'))|ConvertFrom-Json;" +
    '$proofs=@();foreach($text in $cases){$proofs+=Get-CopiedComposerTextProof ([string]$text)};[Console]::Out.WriteLine(($proofs|ConvertTo-Json -Compress))';
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(command, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || 'Actual PowerShell clipboard proof function failed.');
  const actual = JSON.parse(result.stdout.trim());
  assert.deepEqual(actual, cases.map(proof));
}
console.log('PASS clipboard text proof boundaries and actual PowerShell SHA-256/UTF-8 parity; real newlines preserved, no native actions.');
