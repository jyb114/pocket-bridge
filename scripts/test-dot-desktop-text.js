'use strict';
// Actual observed native fragment lengths, synthetic contents. Exercise both
// production serializers without starting the desktop or copying any messages.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const P = require('./dot-desktop-protocol.js');
if (process.platform !== 'win32') { console.log('SKIP Windows Dot text regression.'); process.exit(0); }
const files = ['dot-desktop-ui.ps1', 'dot-desktop-send.ps1'];
const definitions = files.map(file => {
  const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
  const definition = source.match(/^function Join-DotObservedMessage\([^\n]+\) \{\r?\n[\s\S]*?^\}/m)?.[0];
  assert.ok(definition, 'Missing actual serializer in ' + file);
  assert.match(source, /(?:\$text|\$value)=Join-DotObservedMessage \$fragments/);
  return definition.replaceAll('\r\n', '\n');
});
const senderSource = fs.readFileSync(path.join(__dirname, files[1]), 'utf8');
const receiptGuard = senderSource.match(/^function Test-DotReceiptBoundWindow\([^\n]+\) \{\r?\n[\s\S]*?^\}/m)?.[0];
assert.ok(receiptGuard, 'Receipt checks must bind the original process birth and window before native input.');
const receiptScopeGuard = senderSource.match(/^function Test-DotReceiptRenderedScope\([^\n]+\) \{\r?\n[\s\S]*?^\}/m)?.[0];
assert.ok(receiptScopeGuard, 'Receipt metadata must remain in the exact original rendered scope.');
assert.equal(definitions[0], definitions[1], 'Read and receipt hashing must use the same serialization.');
const first = 'x'.repeat(217), token = 't'.repeat(37), observedInput = first + '\n' + token;
const cases = [
  { fragments: [first, '\n', token], self: true, expected: observedInput },
  { fragments: [first, '\n', token], self: false, expected: first + '\n\n\n' + token },
  { fragments: ['single message'], self: true, expected: 'single message' },
  { fragments: ['a', 'b'], self: true, expected: 'ab' },
  { fragments: ['  a ', '\n', ' b  '], self: true, expected: '  a \n b  ' },
  { fragments: ['a', '\n', '\n', 'b'], self: true, expected: 'a\n\nb' },
  { fragments: ['a', '\n\n', 'b'], self: true, expected: 'a\n\nb' },
  { fragments: ['\n'], self: true, expected: '\n' },
  { fragments: ['\n', '\n'], self: true, expected: '\n\n' },
  { fragments: ['a\nb', '\n', 'c\nd'], self: true, expected: 'a\nb\nc\nd' },
  { fragments: ['a\r\nb', '\r\n', 'c'], self: true, expected: 'a\nb\nc' },
  { fragments: ['a\r', '\n', 'b'], self: true, expected: 'a\r\nb' },
  { fragments: ['a', '\n'], self: true, expected: 'a\n' },
  { fragments: ['\n', 'a'], self: true, expected: '\na' },
  { fragments: ['', 'a', '', '\n', 'b', ''], self: true, expected: 'a\nb' },
  { fragments: [], self: true, expected: '' },
  { fragments: [], self: false, expected: '' },
  { fragments: ['paragraph one', 'paragraph two'], self: false, expected: 'paragraph one\nparagraph two' },
  { fragments: ['a\r\nb', 'c\r\nd'], self: false, expected: 'a\nb\nc\nd' },
  { fragments: ['中文 ', '\n', '🙂'], self: true, expected: '中文 \n🙂' }
];
const directory = fs.mkdtempSync(path.join(process.env.DOT_JOURNAL_TEST_DIRECTORY || path.join(__dirname, '..', 'logs'), 'dot-text-fixture-'));
const expectedWindow = { processId: 42, creationTicks: '10000001', windowHandle: '4294967297',
  packageFamilyName: 'OpenAI.Codex_2p2nqsd0c76g0', version: '26.928.3736.0' };
const windowCases = [{ expected: expectedWindow, actual: expectedWindow, valid: true },
  { expected: null, actual: expectedWindow, valid: false }, ...Object.keys(expectedWindow).map(key => ({ expected: expectedWindow,
    actual: { ...expectedWindow, [key]: key === 'processId' ? 43 : expectedWindow[key] + 'changed' }, valid: false }))];
const expectedScope = { ...expectedWindow, threadId: crypto.randomUUID(), hostId: 'durable', viewportRuntimeId: '1,2',
  messageListRuntimeId: '1,3', contextGeneration: P.sha('original-scope') };
const scopeCases = [{ expected: expectedScope, actual: expectedScope, valid: true },
  { expected: null, actual: expectedScope, valid: false }, { expected: expectedScope, actual: null, valid: false },
  ...Object.keys(expectedScope).map(key => ({ expected: expectedScope,
    actual: { ...expectedScope, [key]: key === 'processId' ? 43 : expectedScope[key] + 'changed' }, valid: false }))];
let result;
try {
  fs.writeFileSync(path.join(directory, 'cases.json'), JSON.stringify(cases), 'utf8');
  fs.writeFileSync(path.join(directory, 'receipt-cases.json'), JSON.stringify({ sourcePath: path.join(__dirname, files[1]), cases: windowCases, scopeCases }), 'utf8');
  const command = "$ErrorActionPreference='Stop';\n[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)\n" + definitions[0] +
    "\n$cases=Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $PSScriptRoot 'cases.json')|ConvertFrom-Json\n" +
    "$values=@($cases|ForEach-Object { [ordered]@{text=[string](Join-DotObservedMessage @($_.fragments) $_.self)} })\n" +
    '\n' + receiptGuard + '\n' + receiptScopeGuard + '\n' +
    "$receipt=Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $PSScriptRoot 'receipt-cases.json')|ConvertFrom-Json\n" +
    "$boundValues=@($receipt.cases|ForEach-Object { Test-DotReceiptBoundWindow $_.expected $_.actual.processId $_.actual.creationTicks $_.actual.windowHandle $_.actual.packageFamilyName $_.actual.version })\n" +
    "$scopeValues=@($receipt.scopeCases|ForEach-Object { Test-DotReceiptRenderedScope $_.expected $_.actual })\n" +
    "$tokens=$null;$problems=$null;$ast=[System.Management.Automation.Language.Parser]::ParseFile($receipt.sourcePath,[ref]$tokens,[ref]$problems)\n" +
    "if($problems.Count){throw 'Native helper syntax failed'}\n" +
    "$branches=@($ast.FindAll({param($node) $node -is [System.Management.Automation.Language.IfStatementAst] -and $node.Clauses.Count -eq 1 -and $node.Clauses[0].Item1.Extent.Text -ceq '$observing' -and $node.ElseClause -and $node.ElseClause.Extent.Text.Contains('Protect-DotOutgoingSource')},$true))\n" +
    "if($branches.Count -ne 1){throw 'Missing isolated observe branch'}\n" +
    "$branch=$branches[0].Clauses[0].Item2\n" +
    "$danger=@($branch.FindAll({param($node) ($node -is [System.Management.Automation.Language.CommandAst] -and @('Protect-DotOutgoingSource','Unique-Button','Test-DotActualBlank','Copy-DotDraft','Focus-DotComposer') -ccontains $node.GetCommandName()) -or ($node -is [System.Management.Automation.Language.InvokeMemberExpressionAst] -and @('SendWait','Invoke','Toggle','SetText','SetValue','SetRangeValue') -ccontains $node.Member.Value)},$true))\n" +
    "$copies=@($branch.FindAll({param($node) $node -is [System.Management.Automation.Language.CommandAst] -and $node.GetCommandName() -ceq 'Copy-DurableIdentity'},$true))\n" +
    "$captures=@($branch.FindAll({param($node) $node -is [System.Management.Automation.Language.CommandAst] -and $node.GetCommandName() -ceq 'Capture-DotObservation'},$true))\n" +
    "$opens=@($branch.FindAll({param($node) $node -is [System.Management.Automation.Language.CommandAst] -and $node.GetCommandName() -ceq 'Open-DotReceiptProfile'},$true))\n" +
    "if($danger.Count -ne 0 -or $copies.Count -ne 2 -or $captures.Count -ne 1 -or $opens.Count -ne 1){throw 'Unsafe receipt branch'}\n" +
    "$profileFunctions=@($ast.FindAll({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Open-DotReceiptProfile'},$true))\n" +
    "if($profileFunctions.Count -ne 1){throw 'Missing guarded metadata opener'}\n" +
    "$profile=$profileFunctions[0].Body\n" +
    "$profileDanger=@($profile.FindAll({param($node) ($node -is [System.Management.Automation.Language.CommandAst] -and @('Protect-DotOutgoingSource','Copy-DotDraft','Focus-DotComposer','Test-DotActualBlank') -ccontains $node.GetCommandName()) -or ($node -is [System.Management.Automation.Language.InvokeMemberExpressionAst] -and @('SendWait','Invoke','SetText','SetValue','SetRangeValue') -ccontains $node.Member.Value)},$true))\n" +
    "$toggles=@($profile.FindAll({param($node) $node -is [System.Management.Automation.Language.InvokeMemberExpressionAst] -and $node.Member.Value -ceq 'Toggle'},$true))\n" +
    "$guards=@($profile.FindAll({param($node) $node -is [System.Management.Automation.Language.CommandAst] -and $node.GetCommandName() -ceq 'Assert-DotReceiptReadScope'},$true))\n" +
    "$buttons=@($profile.FindAll({param($node) $node -is [System.Management.Automation.Language.CommandAst] -and $node.GetCommandName() -ceq 'Unique-Button'},$true))\n" +
    "if($profileDanger.Count -ne 0 -or $toggles.Count -ne 1 -or $guards.Count -ne 4 -or $buttons.Count -ne 2){throw 'Unsafe metadata opener'}\n" +
    "foreach($button in $buttons){if($button.CommandElements[1].Extent.Text -cne \"'Toggle profile'\"){throw 'Wrong metadata button'}}\n" +
    "if(@($guards|Where-Object {$_.Extent.StartOffset -lt $toggles[0].Extent.StartOffset}).Count -ne 2 -or -not $profile.Extent.Text.Contains('$profiles.Count -eq 0') -or -not $profile.Extent.Text.Contains('(Key $fresh) -cne $buttonKey')){throw 'Missing pre-toggle scope and fresh-control guards'}\n" +
    "$scopeFunctions=@($ast.FindAll({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Assert-DotReceiptReadScope'},$true))\n" +
    "if($scopeFunctions.Count -ne 1 -or -not $scopeFunctions[0].Body.Extent.Text.Contains('Test-DotReceiptRenderedScope $sendBaseline $candidate')){throw 'Missing original rendered-context binding'}\n" +
    '[Console]::Out.WriteLine((@{texts=$values;windows=$boundValues;scopes=$scopeValues;isolatedReadBranch=$true;guardedMetadataToggle=$true}|ConvertTo-Json -Depth 4 -Compress))';
  fs.writeFileSync(path.join(directory, 'check.ps1'), '\uFEFF' + command, 'utf8');
  result = spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(directory, 'check.ps1')],
    { encoding: 'utf8', windowsHide: true, timeout: 10000, env: { ...process.env, TEMP: directory, TMP: directory } });
} finally {
  for (const file of ['cases.json','receipt-cases.json','check.ps1']) fs.unlinkSync(path.join(directory, file));
  fs.rmdirSync(directory);
}
assert.equal(result.status, 0, result.stderr || 'Dot serializer fixture failed.');
const nativeChecks = JSON.parse(result.stdout.trim()), values = nativeChecks.texts;
assert.equal(nativeChecks.isolatedReadBranch, true);
assert.deepEqual(nativeChecks.windows, windowCases.map(value => value.valid));
assert.deepEqual(nativeChecks.scopes, scopeCases.map(value => value.valid));
assert.equal(nativeChecks.guardedMetadataToggle, true);
assert.equal(values.length, cases.length);
cases.forEach((value, index) => {
  assert.equal(values[index].text, value.expected, 'Native fragment serialization case ' + index);
  assert.equal(P.sha(values[index].text), P.sha(value.expected), 'Exact native row hash case ' + index);
});
assert.equal(observedInput.length, 255);
assert.equal(cases[0].fragments.join('\n').length, 257);
const request = P.normalizeRequest({ requestId: crypto.randomUUID(), threadId: crypto.randomUUID(), text: observedInput });
const operationId = crypto.randomUUID();
const baseline = { schemaVersion: 1, requestId: request.requestId, operationId, requestFingerprint: P.fingerprint(request),
  threadId: request.threadId, hostId: 'durable', packageFamilyName: 'OpenAI.Codex_2p2nqsd0c76g0', version: '26.928.3736.0',
  windowHandle: '1', processId: 1, creationTicks: '1', viewportRuntimeId: '1,2', messageListRuntimeId: '1,3',
  observationSequence: 1, observedAt: 100, materializedRowCount: 1, completeMaterializedScope: true, settled: true,
  viewportBounds: [0,0,800,600], rows: [{ observationId: P.sha('prior'), role: 'assistant', textSha256: P.sha('prior') }] };
baseline.contextGeneration = P.contextGeneration(baseline);
const after = { ...baseline, observationSequence: 2, observedAt: 101, materializedRowCount: 2,
  rows: [...baseline.rows, { observationId: P.sha('new'), role: 'user', textSha256: P.sha(values[0].text) }] };
assert.ok(P.verifyFreshDesktopRow(baseline, after, request, operationId), 'Faithful multiline self row passes the unchanged exact validator.');
assert.equal(P.verifyFreshDesktopRow(baseline, { ...after,
  rows: [after.rows[0], { ...after.rows[1], textSha256: P.sha(cases[0].fragments.join('\n')) }] }, request, operationId), null,
  'Old extra-LF serialization still fails the exact validator.');
console.log('PASS 20 Dot text cases, 2 exact receipt proofs, 7 original-window bindings, 13 rendered-scope bindings and guarded native read-branch AST; no native actions.');
