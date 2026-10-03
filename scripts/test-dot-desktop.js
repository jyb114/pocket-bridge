'use strict';
// Isolated contract/security tests. Native desktop actions are explicit fixtures.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const fs = require('node:fs'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createDotDesktopDriver, validateSnapshot, DotDesktopError } = require('./dot-desktop-driver.js');
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
    const readiness = ['Get-DotNavigationReadiness', 'Test-DotNavigationReadiness', 'Wait-DotSelectedView']
      .map(name => script.match(new RegExp('function ' + name + '(?:\\([^\\n]*\\))? \\{\\r?\\n[\\s\\S]*?\\r?\\n\\}'))?.[0]);
    const processGuards = ['Assert-Process', 'Assert-Foreground']
      .map(name => script.match(new RegExp('    function ' + name + ' \\{\\r?\\n[\\s\\S]*?\\r?\\n    \\}'))?.[0]);
    assert.ok(predicate, 'Extract actual pure native main-window predicate');
    assert.ok(sidebar, 'Extract actual native unread-label matcher');
    assert.ok(readiness.every(Boolean), 'Extract actual post-navigation metadata wait and readiness predicate');
    assert.ok(processGuards.every(Boolean), 'Extract actual process-birth, HWND and foreground guards');
    const navigation = fs.readFileSync(path.join(__dirname, 'dot-desktop-navigation-guard.ps1'), 'utf8');
    const probe = predicate + '\n' + sidebar + '\n' + readiness.join('\n') + '\n' + navigation + '\n' + String.raw`
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
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
$script:fixtureModes=@();$script:fixtureEditors=@()
$script:fixtureRoot=New-Object PSObject
$script:fixtureRoot|Add-Member ScriptMethod FindAll {
    param($Scope,$Condition)
    if($Condition.Value -eq [Windows.Automation.ControlType]::Button.Id){return @($script:fixtureModes)}
    return @($script:fixtureEditors)
}
function Fresh-Root {return $script:fixtureRoot}
function Raw-Contains($Root,$Element) {return $true}
function Has-Class($Element,[string]$Token) {return @($Element.Current.ClassName -split '\s+') -ccontains $Token}
function Dot-Profiles {return @($script:fixtureProfiles)}
$script:fixtureProfiles=@()
function Key($Element) {return $Element.id}
function Fixture-Mode {return @{id='1,2';Current=@{Name='Switch mode, current mode: ChatGPT';IsEnabled=$true;IsOffscreen=$false}}}
function Fixture-Editor([string]$Class) {return @{id='1,3';Current=@{Name='Message';ClassName=$Class;IsEnabled=$true;IsOffscreen=$false;IsKeyboardFocusable=$true;IsPassword=$false}}}
try {$null=Get-DotSourceEvidence;$values.missingSourceRefused=$false}catch {$values.missingSourceRefused=$_.Exception.Message -ceq 'source-unverified'}
$script:fixtureModes=@(Fixture-Mode)
try {$null=Get-DotSourceEvidence;$values.missingEditorRefused=$false}catch {$values.missingEditorRefused=$_.Exception.Message -ceq 'source-unverified'}
$script:fixtureEditors=@((Fixture-Editor 'ChangedComposer'))
try {$null=Get-DotSourceEvidence;$values.unknownEditorShapeRefused=$false}catch {$values.unknownEditorShapeRefused=$_.Exception.Message -ceq 'source-unverified'}
$script:fixtureEditors=@((Fixture-Editor 'ProseMirror'),(Fixture-Editor 'ProseMirror'))
try {$null=Get-DotSourceEvidence;$values.ambiguousEditorRefused=$false}catch {$values.ambiguousEditorRefused=$_.Exception.Message -ceq 'source-unverified'}
$script:fixtureEditors=@((Fixture-Editor 'ProseMirror'))
$script:fixtureProfiles=@(@{id='profile-1'})
$values.chatgptDotProfileProvesCurrentDot=(Get-DotSourceEvidence).currentDot -eq $true
$script:fixtureModes[0].Current.Name='Switch mode, current mode: Codex'
$values.codexSidebarDotProfileProvesCurrentDot=(Get-DotSourceEvidence).currentDot -eq $true
$script:fixtureProfiles=@()
$values.noProfileDoesNotProveDot=(Get-DotSourceEvidence).currentDot -eq $false
$script:fixtureProfiles=@(@{id='profile-1'},@{id='profile-2'})
$values.duplicateProfileDoesNotProveDot=(Get-DotSourceEvidence).currentDot -eq $false
$script:fixtureProfiles=@(@{id='profile-1'})
$script:fixtureEditors[0].Current.Name='Send a message'
$values.codexEditorWithProfileDoesNotProveDot=(Get-DotSourceEvidence).currentDot -eq $false
$script:evidenceReads=0
function Get-DotSourceEvidence {$script:evidenceReads++;return @{mode='chatgpt';modeId='1,2';editorId='1,3';currentDot=$true;editor=@{draft='existing human draft'}}}
$values.sameCurrentDotRead=(Protect-DotOutgoingSource $true '26.928.3736.0') -eq $true -and $script:evidenceReads -eq 2
function Get-DotSourceEvidence {return @{mode='chatgpt';modeId='1,2';editorId='1,3';currentDot=$false}}
try {$null=Protect-DotOutgoingSource $true '26.928.3736.0';$values.unknownSourceRefused=$false}catch {$values.unknownSourceRefused=$_.Exception.Message -ceq 'source-unverified'}
$script:evidenceReads=0
function Get-DotSourceEvidence {$script:evidenceReads++;return @{mode='chatgpt';modeId='1,2';editorId=[string]$script:evidenceReads;currentDot=$true}}
try {$null=Protect-DotOutgoingSource $true '26.928.3736.0';$values.changedEditorRefused=$false}catch {$values.changedEditorRefused=$_.Exception.Message -ceq 'source-unverified'}
` + '\n' + processGuards.join('\n') + '\n' + String.raw`
# These substitutes never call user32 or UI Automation on the real desktop.
# Execute the production readiness loop and process guards against changing
# metadata, including a process birth/foreground change between its polls.
Add-Type -TypeDefinition @'
using System;
public static class DotDesktopNative {
    public static bool ValidWindow=true;
    public static IntPtr Foreground=new IntPtr(111);
    public static bool IsWindow(IntPtr hwnd) {return ValidWindow && hwnd.ToInt64()==111;}
    public static int WindowProcess(IntPtr hwnd) {return hwnd.ToInt64()==111 ? 77 : 78;}
    public static IntPtr GetForegroundWindow() {return Foreground;}
    public static IntPtr GetAncestor(IntPtr hwnd,uint flags) {return hwnd;}
}
'@
$bound=[IntPtr]111;$ownerId=77;$exe='D:\Fixture\Codex.exe'
$script:fixtureCreation=[DateTime]::SpecifyKind([DateTime]'2026-10-02T12:00:00',[DateTimeKind]::Utc)
$creationTicks=$script:fixtureCreation.ToUniversalTime().Ticks
$watch=[Diagnostics.Stopwatch]::StartNew()
function Get-CimInstance {
    param($ClassName,$Filter)
    $script:fixtureGuardReads++
    if($ClassName -cne 'Win32_Process' -or $Filter -cne 'ProcessId=77'){throw 'unexpected-process-query'}
    $birth=$script:fixtureCreation
    if($script:fixtureFaultAt -gt 0 -and $script:fixtureGuardReads -ge $script:fixtureFaultAt){
        if($script:fixtureFaultKind -ceq 'birth'){$birth=$birth.AddSeconds(1)}
        elseif($script:fixtureFaultKind -ceq 'window'){[DotDesktopNative]::ValidWindow=$false}
        elseif($script:fixtureFaultKind -ceq 'foreground'){[DotDesktopNative]::Foreground=[IntPtr]222}
        elseif($script:fixtureFaultKind -ceq 'path'){return @{CreationDate=$birth;ExecutablePath='D:\Fixture\Other.exe'}}
    }
    return @{CreationDate=$birth;ExecutablePath=$exe}
}
function Fixture-Frame([int]$Sidebar=1,[int]$Editor=1,[int]$Profile=1,[int]$Toggle=0){
    $frame=@{buttons=@();editors=@();profiles=@();handle=111;process=77;rootType=[Windows.Automation.ControlType]::Window}
    for($i=0;$i -lt $Sidebar;$i++){$frame.buttons+=@{Current=@{Name='Your dot';ClassName='sidebar-item';IsEnabled=$true;IsOffscreen=$false}}}
    for($i=0;$i -lt $Toggle;$i++){$frame.buttons+=@{Current=@{Name='Toggle profile';ClassName='';IsEnabled=$true;IsOffscreen=$false}}}
    for($i=0;$i -lt $Editor;$i++){$frame.editors+=Fixture-Editor 'ProseMirror'}
    for($i=0;$i -lt $Profile;$i++){$frame.profiles+=@{Current=@{Name=('Your dot'+[string][char]0x2019+'s profile');ClassName='codex-dialog';IsOffscreen=$false}}}
    return $frame
}
function Fresh-Root {
    Assert-Foreground
    $script:fixturePolls++
    $script:fixtureFrame=$script:fixtureFrames[[Math]::Min($script:fixturePolls-1,$script:fixtureFrames.Count-1)]
    $fixture=New-Object PSObject
    $fixture|Add-Member NoteProperty Current @{ControlType=$script:fixtureFrame.rootType;NativeWindowHandle=$script:fixtureFrame.handle;ProcessId=$script:fixtureFrame.process}
    $fixture|Add-Member ScriptMethod FindAll {
        param($Scope,$Condition)
        if($Scope -ne [Windows.Automation.TreeScope]::Descendants){throw 'unexpected-scope'}
        if($Condition.Value -eq [Windows.Automation.ControlType]::Button.Id){return @($script:fixtureFrame.buttons)}
        if($Condition.Value -eq [Windows.Automation.ControlType]::Edit.Id){return @($script:fixtureFrame.editors)}
        if($Condition.Value -eq [Windows.Automation.ControlType]::Window.Id){return @($script:fixtureFrame.profiles)}
        throw 'unexpected-query'
    }
    return $fixture
}
function Before-Input {throw 'unexpected-input'}
function Unique-Button {throw 'unexpected-invocation'}
function Dot-Composer {throw 'unexpected-focus'}
function Invoke-ReadinessFixture($Frames,[int]$FaultAt=0,[string]$FaultKind=''){
    $script:fixtureFrames=@($Frames);$script:fixturePolls=0;$script:fixtureGuardReads=0
    $script:fixtureFaultAt=$FaultAt;$script:fixtureFaultKind=$FaultKind
    [DotDesktopNative]::ValidWindow=$true;[DotDesktopNative]::Foreground=[IntPtr]111
    $time=[Diagnostics.Stopwatch]::StartNew();$code=$null
    try {Wait-DotSelectedView}catch{$code=$_.Exception.Message}
    return @{code=$code;polls=$script:fixturePolls;guards=$script:fixtureGuardReads;milliseconds=$time.ElapsedMilliseconds}
}
$open=Invoke-ReadinessFixture @((Fixture-Frame))
$values.openProfileReady=$null -eq $open.code -and $open.polls -eq 1 -and $open.guards -eq 2
$closed=Invoke-ReadinessFixture @((Fixture-Frame 1 1 0 1))
$values.closedProfileReady=$null -eq $closed.code -and $closed.polls -eq 1 -and $closed.guards -eq 2
$remount=Invoke-ReadinessFixture @((Fixture-Frame 1 0 0 0),(Fixture-Frame 1 1 0 0),(Fixture-Frame))
$values.remountSettles=$null -eq $remount.code -and $remount.polls -eq 3 -and $remount.guards -eq 6 -and $remount.milliseconds -ge 100
$empty=Invoke-ReadinessFixture @((Fixture-Frame 0 0 0 0),(Fixture-Frame 1 1 0 1))
$values.emptyMountSettles=$null -eq $empty.code -and $empty.polls -eq 2 -and $empty.guards -eq 4
$ambiguous=@((Fixture-Frame 2 1 1 0),(Fixture-Frame 1 2 1 0),(Fixture-Frame 1 0 2 0),(Fixture-Frame 1 1 0 2))
$refused=0
foreach($frame in $ambiguous){
    $outcome=Invoke-ReadinessFixture @($frame,(Fixture-Frame))
    if($outcome.code -ceq 'dot-unavailable' -and $outcome.polls -eq 1 -and $outcome.guards -eq 2){$refused++}
}
$values.ambiguityNeverWaits=$refused -eq 4
$timeout=Invoke-ReadinessFixture @((Fixture-Frame 0 0 0 0))
$values.missingViewDeadline=$timeout.code -ceq 'dot-unavailable' -and $timeout.milliseconds -ge 2900 -and $timeout.milliseconds -lt 4500 -and $timeout.guards -eq $timeout.polls*2
$identityRefusals=0
foreach($kind in @('birth','window','path','foreground')){
    $outcome=Invoke-ReadinessFixture @((Fixture-Frame 1 0 0 0),(Fixture-Frame)) 3 $kind
    $expected=if($kind -ceq 'foreground'){'desktop-busy'}else{'desktop-unavailable'}
    if($outcome.code -ceq $expected -and $outcome.polls -eq 1 -and $outcome.guards -eq 3){$identityRefusals++}
}
$values.sameOwnerReattestedEachPoll=$identityRefusals -eq 4
$rootRefusals=0
foreach($kind in @('handle','process','rootType')){
    $frame=Fixture-Frame
    if($kind -ceq 'handle'){$frame.handle=222}
    elseif($kind -ceq 'process'){$frame.process=78}
    else{$frame.rootType=[Windows.Automation.ControlType]::Pane}
    $outcome=Invoke-ReadinessFixture @($frame,(Fixture-Frame))
    if($outcome.code -ceq 'desktop-unavailable' -and $outcome.polls -eq 1 -and $outcome.guards -eq 1){$rootRefusals++}
}
$values.freshRootMustMatchBoundWindow=$rootRefusals -eq 3
$filtered=0
foreach($kind in @('disabled','offscreen','password','unfocusable','class','sidebar')){
    $frame=Fixture-Frame
    if($kind -ceq 'disabled'){$frame.editors[0].Current.IsEnabled=$false}
    elseif($kind -ceq 'offscreen'){$frame.editors[0].Current.IsOffscreen=$true}
    elseif($kind -ceq 'password'){$frame.editors[0].Current.IsPassword=$true}
    elseif($kind -ceq 'unfocusable'){$frame.editors[0].Current.IsKeyboardFocusable=$false}
    elseif($kind -ceq 'class'){$frame.editors[0].Current.ClassName='OtherEditor'}
    else{$frame.buttons[0].Current.ClassName='other-sidebar'}
    $script:fixtureFrames=@($frame);$script:fixturePolls=0;$script:fixtureGuardReads=0;$script:fixtureFaultAt=0
    [DotDesktopNative]::ValidWindow=$true;[DotDesktopNative]::Foreground=[IntPtr]111
    if(-not(Test-DotNavigationReadiness (Get-DotNavigationReadiness))){$filtered++}
}
$values.onlyUsableMetadataIsReady=$filtered -eq 6
$chinese=Fixture-Frame;$chinese.editors[0].Current.Name=(-join @([char]0x6D88,[char]0x606F))
$localized=Invoke-ReadinessFixture @($chinese)
$values.localizedComposerReady=$null -eq $localized.code -and $localized.polls -eq 1 -and $localized.guards -eq 2
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
    check('actual Dot profile and editor identify the durable view in either global desktop mode', values.chatgptDotProfileProvesCurrentDot === true && values.codexSidebarDotProfileProvesCurrentDot === true);
    check('missing or duplicate Dot profiles and an unrelated Codex editor never identify the Dot view', values.noProfileDoesNotProveDot === true && values.duplicateProfileDoesNotProveDot === true && values.codexEditorWithProfileDoesNotProveDot === true);
    check('same current Dot reading preserves an existing draft and reattests the source instead of requiring navigation', values.sameCurrentDotRead === true);
    check('unknown ChatGPT sources and editor changes refuse navigation before any draft action', values.unknownSourceRefused === true && values.changedEditorRefused === true);
    check('missing source mode or editor reports unverified source rather than claiming an existing draft', values.missingSourceRefused === true && values.missingEditorRefused === true);
    check('unrecognized or ambiguous editor shapes remain refused with an unverified source error', values.unknownEditorShapeRefused === true && values.ambiguousEditorRefused === true);
    check('the actual bounded wait accepts a ready unique view with either its open profile or one closed-profile toggle', values.openProfileReady === true && values.closedProfileReady === true);
    check('a zero-control remount settles without a second sidebar invocation or any input action', values.remountSettles === true && values.emptyMountSettles === true);
    check('duplicate sidebars, editors, profiles or toggles fail on the first sample even while another control is missing', values.ambiguityNeverWaits === true);
    check('a missing view fails at the bounded three-second deadline while retaining both identity checks per sample', values.missingViewDeadline === true);
    check('process birth, executable, HWND or foreground changes between polls fail immediately', values.sameOwnerReattestedEachPoll === true);
    check('every fresh UI root must retain the bound main Window handle and owner', values.freshRootMustMatchBoundWindow === true);
    check('disabled, offscreen, password, unfocusable and unknown editor/sidebar controls cannot satisfy readiness', values.onlyUsableMetadataIsReady === true);
    check('the actual readiness collector retains the observed Chinese Dot composer selector', values.localizedComposerReady === true);
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
  for (const code of ['source-unverified', 'draft-present']) {
    const blocked = createDotDesktopService({ driver: { inspect: async () => ({ available: true }),
      snapshot: async () => { throw new DotDesktopError(code, false); } } });
    const failure = await httpCall(blocked, { action: 'connect' });
    check(code + ' keeps its precise refused code and false submitted state through the service',
      failure.status === 503 && failure.body.code === code && failure.body.submitted === false && !Object.hasOwn(failure.body, 'threadId'));
    if (code === 'source-unverified') check('unverified-source recovery asks for Your dot and profile without advising draft deletion',
      failure.body.message.includes('open Your dot and its profile') && failure.body.message.includes('keep any existing draft') && failure.body.message.includes('Nothing was sent'));
    else check('verified draft refusal remains distinct from unverified source recovery', failure.body.message.includes('unsent draft') && !failure.body.message.includes('could not be verified'));
  }
  console.log(passed + ' isolated native Dot contract checks passed');
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
