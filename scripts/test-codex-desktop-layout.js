'use strict';
// Reproduce Chromium's actual contradictory UIA evidence without GUI actions:
// root enumeration finds the editor; scoped layout enumeration omits it;
// fresh raw-parent ancestry still identifies its exact layout Group.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
if (process.platform !== 'win32') {
  console.log('SKIP Windows PowerShell composer layout regression on non-Windows.');
  process.exit(0);
}
const source = fs.readFileSync(path.join(__dirname, 'codex-desktop-ui.ps1'), 'utf8');
function functionSource(name) {
  const start = source.indexOf('    function ' + name + '(');
  const next = source.indexOf('\n    function ', start + 1);
  assert(start >= 0 && next > start, 'Missing production function: ' + name);
  return source.slice(start, next)
    .replaceAll('[Windows.Automation.TreeWalker]::RawViewWalker', '[BridgeLayoutRegression]::RawViewWalker')
    .replaceAll('[Windows.Automation.ControlType]::Group', '[BridgeLayoutRegression]::Group');
}
const mockTypes = `
using System;
public sealed class BridgeLayoutProperties { public string ClassName; public string ControlType; }
public sealed class BridgeLayoutElement {
  public int Id; public BridgeLayoutElement Parent; public BridgeLayoutProperties Current;
  public BridgeLayoutElement(int id,string cls,string type,BridgeLayoutElement parent) {
    Id=id; Parent=parent; Current=new BridgeLayoutProperties{ClassName=cls,ControlType=type};
  }
  public int[] GetRuntimeId() { return new[]{42,Id}; }
}
public sealed class BridgeLayoutWalker { public BridgeLayoutElement GetParent(BridgeLayoutElement e) { return e.Parent; } }
public static class BridgeLayoutRegression {
  public static readonly string Group="Group";
  public static readonly BridgeLayoutWalker RawViewWalker=new BridgeLayoutWalker();
}
`;
const assertions = String.raw`
function Check-Deadline { }
function Check-BoundForeground { }
function Fail-Relay([string]$Code,[string]$Reason) { throw ($Code + '|' + $Reason) }
function Get-CodexComposerCandidates($Scope) {
  if (-not (Runtime-IdsEqual $Scope $script:WindowElement)) { $script:ScopedEnumerationCalls++; return @() }
  $script:RootQueries++
  if ($script:RootQueries -eq 2) {
    if ($script:ChangeOnSecond -eq 'composer') { return @($script:OtherEditor) }
    if ($script:ChangeOnSecond -eq 'multiple') { return @($script:Editor,$script:OtherEditor) }
    if ($script:ChangeOnSecond -eq 'layout') { $script:Editor.Parent=$script:OtherLayout }
    if ($script:ChangeOnSecond -eq 'lost-layout') { $script:Editor.Parent=$script:WindowElement }
  }
  return $script:RootCandidates
}
function Reset-LayoutCase {
  $script:WindowElement=New-Object BridgeLayoutElement(100,'verified-window','Window',$null)
  $script:Layout=New-Object BridgeLayoutElement(200,'_ComposerLayoutBody_observed more-css','Group',$script:WindowElement)
  $script:OtherLayout=New-Object BridgeLayoutElement(201,'_ComposerLayoutBody_observed','Group',$script:WindowElement)
  $script:Editor=New-Object BridgeLayoutElement(300,'ProseMirror','Edit',$script:Layout)
  $script:OtherEditor=New-Object BridgeLayoutElement(301,'ProseMirror','Edit',$script:Layout)
  $script:RootCandidates=@($script:Editor)
  $script:ScopedEnumerationCalls=0; $script:RootQueries=0; $script:ChangeOnSecond='none'
}
function Require-Layout([int]$ExpectedId) {
  $actual=Get-ComposerLayoutBody $script:Editor
  if ($actual.Id -ne $ExpectedId -or $script:ScopedEnumerationCalls -ne 0) { throw 'layout regression failed' }
  $script:Checks++
}
function Require-LayoutDenied {
  $denied=$false
  try { $null=Get-ComposerLayoutBody $script:Editor } catch {
    if (-not $_.Exception.Message.StartsWith('composer-unavailable|')) { throw }
    $denied=$true
  }
  if (-not $denied) { throw 'unsafe layout accepted' }
  $script:Checks++
}
$script:Checks=0
Reset-LayoutCase; Require-Layout 200
Reset-LayoutCase; $script:RootCandidates=@(); Require-LayoutDenied
Reset-LayoutCase; $script:RootCandidates=@($script:Editor,$script:OtherEditor); Require-LayoutDenied
Reset-LayoutCase; $script:RootCandidates=@($script:OtherEditor); Require-LayoutDenied
Reset-LayoutCase; $script:Editor.Parent=New-Object BridgeLayoutElement(999,'_ComposerLayoutBody_foreign','Group',$null); Require-LayoutDenied
Reset-LayoutCase; $script:Layout.Current.ControlType='Button'; Require-LayoutDenied
Reset-LayoutCase; $script:Layout.Current.ClassName='unverified-layout'; Require-LayoutDenied
Reset-LayoutCase; $script:Layout.Current.ClassName='_ComposerLayoutBody_a _ComposerLayoutBody_b'; Require-LayoutDenied
Reset-LayoutCase; $outer=New-Object BridgeLayoutElement(250,'_ComposerLayoutBody_outer','Group',$script:WindowElement); $script:Layout.Parent=$outer; Require-Layout 200
Reset-LayoutCase; $script:ChangeOnSecond='composer'; Require-LayoutDenied
Reset-LayoutCase; $script:ChangeOnSecond='multiple'; Require-LayoutDenied
Reset-LayoutCase; $script:ChangeOnSecond='layout'; Require-LayoutDenied
Reset-LayoutCase; $script:ChangeOnSecond='lost-layout'; Require-LayoutDenied
Reset-LayoutCase; $wrapper=New-Object BridgeLayoutElement(280,'editor-wrapper','Group',$script:Layout); $script:Editor.Parent=$wrapper; Require-Layout 200
[Console]::Out.WriteLine($script:Checks)
`;
const command = "$ErrorActionPreference='Stop';\nAdd-Type -TypeDefinition @'\n" + mockTypes + "\n'@\n" +
  functionSource('Runtime-IdsEqual') + '\n' + functionSource('Element-IsInBoundWindow') + '\n' +
  functionSource('Get-ComposerLayoutBody') + '\n' + assertions;
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const nativeTemp = path.join(path.dirname(__dirname), 'logs', 'native-temp');
fs.mkdirSync(nativeTemp, { recursive: true });
const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
  Buffer.from(command, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 10000,
  env: { ...process.env, TEMP: nativeTemp, TMP: nativeTemp } });
assert.equal(result.status, 0, result.stderr || 'Production composer layout regression failed.');
assert.equal(Number(result.stdout.trim()), 14);
console.log('PASS 14 production PowerShell composer layout regressions with a simulated UIA tree; no desktop actions.');
