'use strict';
// Run the actual focus/readiness and strict identity predicates on synthetic
// UIA/native state. No desktop, clipboard, keys or native input API is called.
const assert = require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {spawnSync}=require('node:child_process');
if(process.platform!=='win32'){console.log('SKIP Windows focus readiness regression.');process.exit(0);}
const source=fs.readFileSync(path.join(__dirname,'codex-desktop-ui.ps1'),'utf8');
const types=String.raw`
using System;
public sealed class FocusReadinessProperties {public int ProcessId=123;}
public sealed class FocusReadinessNode {
  public int Id;public FocusReadinessNode Parent;public FocusReadinessProperties Current=new FocusReadinessProperties();
  public FocusReadinessNode(int id,FocusReadinessNode parent){Id=id;Parent=parent;}
  public int[] GetRuntimeId(){return new[]{42,Id};}
  public void SetFocus(){FocusReadinessFixture.SetCalls++;if(FocusReadinessFixture.ThrowSet)throw new InvalidOperationException("set focus refused");}
}
public sealed class FocusReadinessWalker {public FocusReadinessNode GetParent(FocusReadinessNode node){return node.Parent;}}
public static class FocusReadinessFixture {
  public static readonly FocusReadinessWalker Walker=new FocusReadinessWalker();
  public static FocusReadinessNode Editor,Child,Other,Foreign,Root,ForeignRoot,Replacement;
  public static int SetCalls,FocusReads,ReadyAt,ForeignFocusAt,FinalOtherAt,FindCalls,ReplaceAt,DuplicateAt,IdentityCalls,DeadProcessAt,ForeignWindowAt,ClosedWindowAt;
  public static bool NullUntilReady,ChildFocus,ThrowSet;
  public static FocusReadinessNode FocusedElement {get{
    FocusReads++;
    if(ForeignFocusAt>0&&FocusReads>=ForeignFocusAt)return Foreign;
    if(FinalOtherAt>0&&FocusReads>=FinalOtherAt)return Other;
    if(ReadyAt>0&&FocusReads>=ReadyAt)return ChildFocus?Child:Editor;
    return NullUntilReady?null:Other;
  }}
  public static IntPtr GetForegroundWindow(){return new IntPtr(ForeignWindowAt>0&&IdentityCalls>=ForeignWindowAt?456:123);}
  public static bool IsWindow(IntPtr window){return !(ClosedWindowAt>0&&IdentityCalls>=ClosedWindowAt&&window.ToInt64()==123);}
  public static int WindowProcess(IntPtr window){return window.ToInt64()==456?124:123;}
  public static IntPtr GetAncestor(IntPtr window,uint flags){return window;}
  public static void Reset(){
    SetCalls=FocusReads=FindCalls=IdentityCalls=0;ReadyAt=1;ForeignFocusAt=FinalOtherAt=ReplaceAt=DuplicateAt=DeadProcessAt=ForeignWindowAt=ClosedWindowAt=0;
    NullUntilReady=ChildFocus=ThrowSet=false;
    Root=new FocusReadinessNode(100,null);Editor=new FocusReadinessNode(200,Root);Child=new FocusReadinessNode(201,Editor);Other=new FocusReadinessNode(300,Root);
    ForeignRoot=new FocusReadinessNode(400,null);ForeignRoot.Current.ProcessId=124;Foreign=new FocusReadinessNode(401,ForeignRoot);Foreign.Current.ProcessId=124;
    Replacement=new FocusReadinessNode(500,Root);
  }
}
`;
const checks=String.raw`
$script:Checks=0
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:PBF_SOURCE_FILE,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Production focus AST must parse.'}
foreach($name in @('Runtime-IdsEqual','Element-IsInBoundWindow','Foreground-IsBoundWindow','Check-BoundForeground','Find-Composer','Check-ComposerFocus','Focus-Composer')){
  $definitions=@($ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name},$true))
  if($definitions.Count -ne 1){throw ('Unique production function required: '+$name)}
  $definition=[string]$definitions[0].Extent.Text
  $definition=$definition.Replace('[Windows.Automation.AutomationElement]::FocusedElement','[FocusReadinessFixture]::FocusedElement').Replace('[Windows.Automation.TreeWalker]::RawViewWalker','[FocusReadinessFixture]::Walker').Replace('[BridgeDesktopNative]','[FocusReadinessFixture]')
  Invoke-Expression $definition
}
function Require([bool]$Condition,[string]$Description){if(-not $Condition){throw ('Focus readiness regression: '+$Description)};$script:Checks++}
function Fail-Relay([string]$Code,[string]$Reason){throw ($Code+'|'+$Reason)}
function Check-Deadline{if($script:FailDeadline){throw 'deadline-refused'}}
function Check-ProcessIdentity($Desktop,[int]$ProcessId){
  Check-Deadline
  [FocusReadinessFixture]::IdentityCalls++
  if($ProcessId -ne 123 -or ([FocusReadinessFixture]::DeadProcessAt -gt 0 -and [FocusReadinessFixture]::IdentityCalls -ge [FocusReadinessFixture]::DeadProcessAt)){
    Fail-Relay 'target-mismatch' 'The continuously held process no longer matches.'
  }
}
function Get-CodexComposerCandidates($Root){
  [FocusReadinessFixture]::FindCalls++
  if([FocusReadinessFixture]::DuplicateAt -gt 0 -and [FocusReadinessFixture]::FindCalls -ge [FocusReadinessFixture]::DuplicateAt){return @([FocusReadinessFixture]::Editor,[FocusReadinessFixture]::Replacement)}
  if([FocusReadinessFixture]::ReplaceAt -gt 0 -and [FocusReadinessFixture]::FindCalls -ge [FocusReadinessFixture]::ReplaceAt){return @([FocusReadinessFixture]::Replacement)}
  return @([FocusReadinessFixture]::Editor)
}
function Reset-Case{
  [FocusReadinessFixture]::Reset();$script:Desktop=[pscustomobject]@{};$script:BoundWindow=[IntPtr]123;$script:BoundProcess=123
  $script:WindowElement=[FocusReadinessFixture]::Root;$script:FailDeadline=$false
  $script:Started=[Diagnostics.Stopwatch]::StartNew();$script:IdentityCopyKind='none';$script:IdentityCopyPhase='none'
}
function Invoke-Case([bool]$Expected,[string]$Description,[int]$ExpectedSetCalls=1){
  $passed=$true;$watch=[Diagnostics.Stopwatch]::StartNew();$script:Failure=''
  try{Focus-Composer ([FocusReadinessFixture]::Editor)}catch{$passed=$false;$script:Failure=$_.Exception.Message}
  $script:ElapsedMs=$watch.ElapsedMilliseconds
  Require ($passed -eq $Expected) $Description
  Require ([FocusReadinessFixture]::SetCalls -eq $ExpectedSetCalls) ($Description+' has exactly the authorized SetFocus attempts')
}
Reset-Case;Invoke-Case $true 'Already-ready exact composer succeeds without a fixed sleep'
Require ([FocusReadinessFixture]::FindCalls -eq 1 -and [FocusReadinessFixture]::FocusReads -eq 2) 'Ready focus uses fresh unique composer and existing strict final focus check.'
Reset-Case;[FocusReadinessFixture]::ReadyAt=3;Invoke-Case $true 'Delayed same-window focus is awaited'
Require ([FocusReadinessFixture]::FindCalls -eq 3 -and [FocusReadinessFixture]::FocusReads -eq 4) 'Every readiness sample freshly verifies editor and final focus.'
Require ([FocusReadinessFixture]::IdentityCalls -ge [FocusReadinessFixture]::FindCalls+2) 'Every readiness sample passes the existing process/foreground identity gate.'
Reset-Case;[FocusReadinessFixture]::ReadyAt=3;[FocusReadinessFixture]::NullUntilReady=$true;Invoke-Case $true 'A temporarily missing focused element may settle without input'
Reset-Case;[FocusReadinessFixture]::ChildFocus=$true;Invoke-Case $true 'Exact composer descendant retains the existing strict focus ancestry rule'
Reset-Case;[FocusReadinessFixture]::ReadyAt=0;Invoke-Case $false 'Never-ready focus times out'
Require ($script:ElapsedMs -ge 1100 -and $script:ElapsedMs -lt 1800) 'Readiness has a bounded local wait.'
Require ($script:Failure.Contains('did not receive keyboard focus in time')) 'Timeout describes unconfirmed readiness.'
Reset-Case;[FocusReadinessFixture]::ReadyAt=5;[FocusReadinessFixture]::ForeignFocusAt=1;Invoke-Case $false 'Foreign-process focused element fails immediately'
Require ([FocusReadinessFixture]::FocusReads -eq 1 -and [FocusReadinessFixture]::FindCalls -eq 1) 'Foreign focus is never polled again or reclaimed.'
Reset-Case;[FocusReadinessFixture]::Foreign.Current.ProcessId=123;[FocusReadinessFixture]::ForeignFocusAt=1;Invoke-Case $false 'Other raw window in the same process is refused immediately'
Reset-Case;[FocusReadinessFixture]::ReadyAt=5;[FocusReadinessFixture]::ForeignWindowAt=2;Invoke-Case $false 'Foreign foreground window is refused before focused-element sampling'
Require ([FocusReadinessFixture]::FocusReads -eq 0) 'Foreign foreground cannot authorize any editor focus sample.'
Reset-Case;[FocusReadinessFixture]::ReadyAt=5;[FocusReadinessFixture]::DeadProcessAt=2;Invoke-Case $false 'Process exit or identity failure aborts readiness immediately'
Require ([FocusReadinessFixture]::FocusReads -eq 0) 'Dead process cannot authorize any editor focus sample.'
Reset-Case;[FocusReadinessFixture]::ReadyAt=5;[FocusReadinessFixture]::ClosedWindowAt=2;Invoke-Case $false 'Destroyed bound window aborts readiness immediately'
Reset-Case;[FocusReadinessFixture]::ReadyAt=5;[FocusReadinessFixture]::ReplaceAt=1;Invoke-Case $false 'Replaced runtime composer ID fails immediately'
Require ([FocusReadinessFixture]::FocusReads -eq 0 -and [FocusReadinessFixture]::FindCalls -eq 1) 'Replaced composer is not refocused or awaited.'
Reset-Case;[FocusReadinessFixture]::ReadyAt=5;[FocusReadinessFixture]::DuplicateAt=1;Invoke-Case $false 'Duplicate composers fail immediately'
Require ([FocusReadinessFixture]::FocusReads -eq 0 -and [FocusReadinessFixture]::FindCalls -eq 1) 'Ambiguous editor is not refocused or awaited.'
Reset-Case;[FocusReadinessFixture]::ReadyAt=4;[FocusReadinessFixture]::ReplaceAt=2;Invoke-Case $false 'Replacement after an initial not-ready sample aborts'
Require ([FocusReadinessFixture]::FindCalls -eq 2 -and [FocusReadinessFixture]::FocusReads -eq 1) 'Fresh identity is verified again on later polls.'
Reset-Case;[FocusReadinessFixture]::FinalOtherAt=2;Invoke-Case $false 'Existing strict final focus gate still rejects a last-moment focus change'
Require ($script:Failure.Contains('lost keyboard focus')) 'Strict final focus failure is not caught and retried.'
Reset-Case;[FocusReadinessFixture]::ThrowSet=$true;Invoke-Case $false 'SetFocus failure does not retry the operation'
Require ([FocusReadinessFixture]::FindCalls -eq 0 -and [FocusReadinessFixture]::FocusReads -eq 0) 'Failed SetFocus grants no readiness authority.'
Reset-Case;[FocusReadinessFixture]::DeadProcessAt=1;Invoke-Case $false 'Already-dead process blocks the first SetFocus' 0
Require ([FocusReadinessFixture]::FindCalls -eq 0 -and [FocusReadinessFixture]::FocusReads -eq 0) 'Initial identity failure admits no readiness work.'
Reset-Case;[FocusReadinessFixture]::ForeignWindowAt=1;Invoke-Case $false 'Already-foreign foreground blocks the first SetFocus' 0
Require ([FocusReadinessFixture]::FindCalls -eq 0 -and [FocusReadinessFixture]::FocusReads -eq 0) 'Initial foreground failure admits no readiness work.'
Reset-Case;$script:FailDeadline=$true;Invoke-Case $false 'Overall driver deadline failure is preserved' 0
Require ($script:Failure -ceq 'deadline-refused') 'Deadline failure is not transformed into polling success.'
[Console]::Out.WriteLine($script:Checks)
`;
const isolated=fs.mkdtempSync(path.join(process.env.DOT_JOURNAL_TEST_DIRECTORY||path.join(__dirname,'..','logs'),'focus-readiness-fixture-'));
let result;
try{
  fs.writeFileSync(path.join(isolated,'check.ps1'),'\uFEFF'+"$ErrorActionPreference='Stop';\nAdd-Type -TypeDefinition @'\n"+types+"\n'@\n"+checks,'utf8');
  result=spawnSync(path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),
    ['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(isolated,'check.ps1')],
    {encoding:'utf8',windowsHide:true,timeout:15000,env:{...process.env,TEMP:isolated,TMP:isolated,PBF_SOURCE_FILE:path.join(__dirname,'codex-desktop-ui.ps1')}});
}finally{fs.unlinkSync(path.join(isolated,'check.ps1'));}
assert.equal(result.status,0,result.stderr||result.error?.message||'Focus fixture failed.');
assert.equal(Number(result.stdout.trim()),52);
const start=source.indexOf('    function Focus-Composer('),end=source.indexOf('\n    function ',start+1);
const focus=source.slice(start,end);
assert.equal((focus.match(/\.SetFocus\(/g)||[]).length,1,'Readiness never attempts another SetFocus.');
assert.doesNotMatch(focus,/\[Windows\.Forms\.(Clipboard|SendKeys)\]|Copy-DesktopIdentity|\.Invoke\(/,'Readiness contains no clipboard/keyboard/send actions.');
assert.match(focus,/Check-ComposerFocus \$Element/,'Existing strict focus verification remains the final gate.');
console.log('PASS 52 actual focus/foreground/composer predicate readiness checks; no native UI or input actions.');
