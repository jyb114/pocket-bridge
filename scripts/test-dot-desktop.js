'use strict';
// Isolated contract/security tests. Native desktop actions are explicit fixtures.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const fs = require('node:fs'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createDotDesktopDriver, validateSnapshot } = require('./dot-desktop-driver.js');
const { createDotDesktopService } = require('./dot-desktop-service.js');
const ID = '11111111-2222-7333-8444-555555555555';
const OTHER = '11111111-2222-7333-8444-555555555556';
const raw = { ok: true, hostId: 'durable', threadId: ID, observedAt: 1,
  historyScope: 'materialized-recent', materializedRowCount: 2,
  messages: [{ observationId: 'a'.repeat(64), role: 'user', text: 'Fixture user', hasText: true },
    { observationId: 'b'.repeat(64), role: 'assistant', text: 'Fixture answer', hasText: true }] };
let passed = 0;
function check(name, value) { assert.ok(value, name); passed++; console.log('PASS ' + name); }
async function httpCall(service, value, overrides = {}) {
  const req = Readable.from([Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))]);
  Object.assign(req, { method: 'POST', url: '/dot/desktop', headers: {
    host: '127.0.0.1:12345', origin: 'http://127.0.0.1:12345', 'x-dsh-dot': '1', 'x-dsh-e2ee': '1'
  }, __dshE2eeDecrypted: true }, overrides);
  return new Promise(resolve => {
    const res = { destroyed: false, writeHead(status) { this.status = status; },
      end(body) { this.destroyed = true; resolve({ status: this.status, body: JSON.parse(body) }); } };
    service.handle(req, res);
  });
}
(async () => {
  if (process.platform === 'win32') {
    const script = fs.readFileSync(path.join(__dirname, 'dot-desktop-ui.ps1'), 'utf8');
    const predicate = script.match(/function Test-DotMainWindowEvidence\([^\n]+\) \{\r?\n[\s\S]*?\r?\n\}/)?.[0];
    const sidebar = script.match(/function Test-DotSidebarLabel\([^\n]+\) \{\r?\n[\s\S]*?\r?\n\}/)?.[0];
    assert.ok(predicate, 'Extract actual pure native main-window predicate');
    assert.ok(sidebar, 'Extract actual native unread-label matcher');
    const navigation = fs.readFileSync(path.join(__dirname, 'dot-desktop-navigation-guard.ps1'), 'utf8');
    const probe = predicate + '\n' + sidebar + '\n' + navigation + '\n' + String.raw`
$values=[ordered]@{
 genuine=(Test-DotMainWindowEvidence $true $true 1);
 paneWithSidebar=(Test-DotMainWindowEvidence $false $true 1);
 editorOnly=(Test-DotMainWindowEvidence $true $true 0);
 foreignNativeHandle=(Test-DotMainWindowEvidence $true $false 1);
 duplicateSidebar=(Test-DotMainWindowEvidence $true $true 2);
}
$twoRealMain=@(@{root=$true;hwnd=$true;sidebar=1},@{root=$true;hwnd=$true;sidebar=1},@{root=$false;hwnd=$true;sidebar=0})
$oneMainWithAux=@(@{root=$true;hwnd=$true;sidebar=1},@{root=$false;hwnd=$true;sidebar=0})
$values.twoRealMainCount=@($twoRealMain|Where-Object {Test-DotMainWindowEvidence $_.root $_.hwnd $_.sidebar}).Count
$values.oneMainWithAuxCount=@($oneMainWithAux|Where-Object {Test-DotMainWindowEvidence $_.root $_.hwnd $_.sidebar}).Count
$values.validUnread=@('Your dot','Your dot 1 unread message','Your dot 2 unread messages','Your dot 999999 unread messages'|Where-Object {Test-DotSidebarLabel $_}).Count
$values.invalidUnread=@('Your dot 0 unread messages','Your dot 1 unread messages','Your dot 2 unread message','Your dot -1 unread message','Your dot 1000000 unread messages','Your dot 1 unread message elsewhere','Your dot arbitrary'|Where-Object {Test-DotSidebarLabel $_}).Count
function Assert-Foreground {}
function Fail-Dot([string]$Code) {throw $Code}
$script:evidenceReads=0
function Get-DotSourceEvidence {$script:evidenceReads++;return @{mode='chatgpt';modeId='1,2';editorId='1,3';currentDot=$true;editor=@{draft='existing human draft'}}}
$values.sameCurrentDotRead=(Protect-DotOutgoingSource $true '26.928.3736.0') -eq $true -and $script:evidenceReads -eq 2
function Get-DotSourceEvidence {return @{mode='chatgpt';modeId='1,2';editorId='1,3';currentDot=$false}}
try {$null=Protect-DotOutgoingSource $true '26.928.3736.0';$values.unknownSourceRefused=$false}catch {$values.unknownSourceRefused=$_.Exception.Message -ceq 'draft-present'}
$script:evidenceReads=0
function Get-DotSourceEvidence {$script:evidenceReads++;return @{mode='chatgpt';modeId='1,2';editorId=[string]$script:evidenceReads;currentDot=$true}}
try {$null=Protect-DotOutgoingSource $true '26.928.3736.0';$values.changedEditorRefused=$false}catch {$values.changedEditorRefused=$_.Exception.Message -ceq 'draft-present'}
$values|ConvertTo-Json -Compress
`;
    const result = spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', probe], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 0, result.stderr); const values = JSON.parse(result.stdout.trim());
    check('actual main-window predicate accepts only the native Window with its unique Your dot sidebar', values.genuine === true);
    check('same-title panes, editor-only lookalikes and wrong native handles are rejected', values.paneWithSidebar === false && values.editorOnly === false && values.foreignNativeHandle === false);
    check('an auxiliary Pane does not make the one genuine main window ambiguous', values.oneMainWithAuxCount === 1);
    check('two genuinely verified main windows remain ambiguous and duplicate sidebars fail closed', values.twoRealMainCount === 2 && values.duplicateSidebar === false);
    check('the exact actually observed unread Dot label is accepted with closed count and singular/plural grammar', values.validUnread === 4 && values.invalidUnread === 0);
    check('same current Dot reading preserves an existing draft and reattests the source instead of requiring navigation', values.sameCurrentDotRead === true);
    check('unknown ChatGPT sources and editor changes refuse navigation before any draft action', values.unknownSourceRefused === true && values.changedEditorRefused === true);
  }
  const result = validateSnapshot(raw, ID);
  check('native Dot snapshots explicitly retain the durable host and recent materialized history scope',
    result.hostId === 'durable' && result.historyScope === 'materialized-recent' && result.stableMessageIds === false);
  check('a transcript read never claims local computer execution or sending capability',
    result.taskExecution === 'unknown' && result.localComputerAccess === 'unverified' && result.sendAvailable === false);
  for (const [name, replacement] of [
    ['local Codex host', { hostId: 'local' }], ['wrong durable conversation', { threadId: OTHER }],
    ['full cloud history claim', { historyScope: 'complete' }],
    ['duplicate ephemeral observation IDs', { messages: [raw.messages[0], raw.messages[0]] }],
    ['unknown message role', { messages: [{ ...raw.messages[0], role: 'tool' }] }],
    ['unbounded message body', { messages: [{ ...raw.messages[0], text: 'x'.repeat(32769) }] }],
    ['false text availability', { messages: [{ ...raw.messages[0], hasText: false }] }]
  ]) {
    assert.throws(() => validateSnapshot({ ...raw, ...replacement }, ID)); check(name + ' is rejected', true);
  }
  const labels = [], payloads = [], spawns = [];
  const driver = createDotDesktopDriver({ platform: 'win32', runDesktopAction: (label, operation) => { labels.push(label); return operation(); },
    spawn(exe, args, options) {
      spawns.push({ exe, args, options });
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = { resume() {} };
      child.kill = () => {}; child.stdin = new EventEmitter();
      child.stdin.end = payload => {
        const request = JSON.parse(payload.toString()); payloads.push(request);
        process.nextTick(() => { child.stdout.emit('data', Buffer.from(JSON.stringify(request.action === 'inspect' ?
          { ok: true, available: true, desktopRunning: true, version: '26.928.3736.0' } : raw))); child.emit('close', 0); });
      }; return child;
    } });
  await driver.inspect(); await driver.snapshot({ threadId: ID });
  check('the independent native driver uses the shared dot-read scheduler for the full helper lifecycle', labels.join(',') === 'dot-read,dot-read');
  check('private durable target identity travels only through stdin, not process arguments',
    payloads[1].expectedThreadId === ID && !spawns.some(spawn => spawn.args.some(arg => arg.includes(ID))));
  check('the native helper remains hidden and common API credentials are excluded from its environment',
    spawns.every(spawn => spawn.options.windowsHide && !Object.hasOwn(spawn.options.env, 'OPENAI_API_KEY') && !Object.hasOwn(spawn.options.env, 'ACCESS_TOKEN')));
  await assert.rejects(driver.send({ threadId: ID, text: 'Not sent' }), error => error.code === 'send-unavailable' && error.submitted === false);
  check('unverified draft detection cannot expose a native Send action', payloads.length === 2);
  {
    const scheduler = require('./desktop-ui-action.js').createDesktopActionScheduler();
    let pendingChild, killed = false, settled = false;
    const delayedExit = createDotDesktopDriver({ platform: 'win32', runDesktopAction: scheduler.runDesktopAction,
      spawn() {
        pendingChild = new EventEmitter(); pendingChild.stdout = new EventEmitter(); pendingChild.stderr = { resume() {} };
        pendingChild.kill = () => { killed = true; }; pendingChild.stdin = new EventEmitter();
        pendingChild.stdin.end = () => process.nextTick(() => pendingChild.stdout.emit('data', Buffer.alloc(256 * 1024 + 1)));
        return pendingChild;
      } });
    const operation = delayedExit.snapshot({ threadId: ID }).then(() => { settled = true; }, cause => { settled = true; return cause; });
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(scheduler.runDesktopAction('codex-inspect', async () => true), cause => cause.code === 'desktop-busy');
    check('oversized native output retains the shared lease after kill until actual helper exit', killed && !settled);
    pendingChild.emit('close', 1); const cause = await operation;
    check('helper exit releases the lease and returns a sanitized history failure',
      cause.code === 'history-unavailable' && await scheduler.runDesktopAction('codex-inspect', async () => true));
    let errorChild, errorSettled = false;
    const childError = createDotDesktopDriver({ platform: 'win32', runDesktopAction: scheduler.runDesktopAction,
      spawn() {
        errorChild = new EventEmitter(); errorChild.pid = 123; errorChild.stdout = new EventEmitter();
        errorChild.stderr = { resume() {} }; errorChild.stdin = new EventEmitter(); errorChild.kill = () => {};
        errorChild.stdin.end = () => process.nextTick(() => errorChild.emit('error', Error('Private helper failure')));
        return errorChild;
      } });
    const errorOperation = childError.inspect().then(value => { errorSettled = true; return value; });
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(scheduler.runDesktopAction('codex-send', async () => true), cause => cause.code === 'desktop-busy');
    check('a helper error with a process ID retains the shared lease until close', !errorSettled);
    errorChild.emit('close', 1); const unavailable = await errorOperation;
    check('the failed helper closes before reporting unavailable and releasing the lease',
      unavailable.available === false && unavailable.reason === 'desktop-unavailable' &&
      await scheduler.runDesktopAction('codex-inspect', async () => true));
  }
  const calls = [];
  const service = createDotDesktopService({ driver: { inspect: async () => ({ available: true }),
    snapshot: async input => { calls.push(input); return validateSnapshot(raw, input.threadId); } } });
  let response = await httpCall(service, { action: 'snapshot' });
  check('refresh cannot read an unbound Dot target', response.status === 409 && response.body.code === 'not-connected' && calls.length === 0);
  response = await httpCall(service, { action: 'connect' });
  check('first Connect binds only a complete verified native Dot snapshot', response.status === 200 && response.body.threadId === ID && calls.length === 1);
  await httpCall(service, { action: 'snapshot' });
  check('later refreshes enforce the previously paired durable UUID', calls[1].threadId === ID);
  response = await httpCall(service, { action: 'snapshot', threadId: OTHER });
  check('a phone cannot redirect its paired Dot snapshot to another conversation', response.status === 409 && calls.length === 2);
  for (const [name, overrides] of [
    ['plaintext requests', { __dshE2eeDecrypted: false }],
    ['forged decryption headers', { __dshE2eeDecrypted: false, headers: { host: '127.0.0.1:12345', 'x-dsh-dot': '1', 'x-dsh-e2ee': '1', 'x-dsh-e2ee-decrypted': '1' } }],
    ['cross-origin native actions', { headers: { host: '127.0.0.1:12345', origin: 'https://other.example', 'x-dsh-dot': '1', 'x-dsh-e2ee': '1' } }],
    ['missing page-specific source', { headers: { host: '127.0.0.1:12345', 'x-dsh-e2ee': '1' } }]
  ]) {
    response = await httpCall(service, { action: 'connect' }, overrides);
    check(name + ' are rejected before native interaction', response.status === 403 && calls.length === 2);
  }
  response = await httpCall(service, { action: 'send', text: 'Preserve this draft' });
  check('sending is explicitly unavailable and does not call a native helper', response.status === 409 && response.body.submitted === false && calls.length === 2);
  response = await httpCall(service, { action: 'connect', nativeAction: 'approve' });
  check('arbitrary native actions cannot be smuggled into the Dot protocol', response.status === 400 && calls.length === 2);
  response = await httpCall(service, 'x'.repeat(25000));
  check('oversized requests are rejected without reading the desktop', response.status === 413 && calls.length === 2);
  console.log(passed + ' isolated native Dot contract checks passed');
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
