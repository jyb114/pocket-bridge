'use strict';
// Exercise the actual production structural predicate against synthetic UIA
// trees. Native empty/typed counterprobes remain a separate acceptance check.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
if (process.platform !== 'win32') {
  console.log('SKIP Windows PowerShell placeholder regression on non-Windows.');
  process.exit(0);
}
const source = fs.readFileSync(path.join(__dirname, 'codex-desktop-ui.ps1'), 'utf8');
function functionSource(name) {
  const start = source.indexOf('    function ' + name + '(');
  const next = source.indexOf('\n    function ', start + 1);
  assert(start >= 0 && next > start, 'Missing production function: ' + name);
  return source.slice(start, next)
    .replaceAll('[Windows.Automation.TreeWalker]::RawViewWalker', '[BridgePlaceholderRegression]::RawViewWalker')
    .replaceAll('[Windows.Automation.ControlType]::Group', '[BridgePlaceholderRegression]::Group')
    .replaceAll('[Windows.Automation.ControlType]::Text', '[BridgePlaceholderRegression]::Text')
    .replaceAll('[Windows.Automation.ControlType]::Button', '[BridgePlaceholderRegression]::Button')
    .replaceAll('[Windows.Automation.ControlType]::Image', '[BridgePlaceholderRegression]::Image')
    .replaceAll('[Windows.Automation.TextPattern]::Pattern', '[BridgePlaceholderRegression]::TextPattern')
    .replaceAll('[Windows.Automation.ValuePattern]::Pattern', '[BridgePlaceholderRegression]::ValuePattern');
}
const mockTypes = String.raw`
using System;
using System.Collections.Generic;
public sealed class BridgePlaceholderProperties {
  public string ClassName, ControlType, Name; public int ProcessId=123;
  public bool IsKeyboardFocusable, IsPassword, IsOffscreen; public bool IsEnabled=true;
}
public sealed class BridgePlaceholderValueProperties { public bool IsReadOnly; public string Value; }
public sealed class BridgePlaceholderValue { public BridgePlaceholderValueProperties Current=new BridgePlaceholderValueProperties(); }
public sealed class BridgePlaceholderRange { public string Text; public string GetText(int count) { return Text; } }
public sealed class BridgePlaceholderText { public BridgePlaceholderRange DocumentRange=new BridgePlaceholderRange(); }
public sealed class BridgePlaceholderElement {
  public int Id; public BridgePlaceholderElement Parent; public BridgePlaceholderProperties Current;
  public List<BridgePlaceholderElement> Children=new List<BridgePlaceholderElement>();
  public BridgePlaceholderValue Value=new BridgePlaceholderValue(); public BridgePlaceholderText Text=new BridgePlaceholderText();
  public bool HasValue=true,HasText=true;
  public BridgePlaceholderElement(int id,string cls,string type,string name,BridgePlaceholderElement parent) {
    Id=id; Parent=parent; Current=new BridgePlaceholderProperties{ClassName=cls,ControlType=type,Name=name};
    if(parent!=null) parent.Children.Add(this);
  }
  public int[] GetRuntimeId() { return new[]{42,Id}; }
  public bool TryGetCurrentPattern(object pattern,out object value) {
    value=null;
    if((string)pattern=="value" && HasValue) { value=Value; return true; }
    if((string)pattern=="text" && HasText) { value=Text; return true; }
    return false;
  }
}
public sealed class BridgePlaceholderWalker {
  public BridgePlaceholderElement GetParent(BridgePlaceholderElement e) { return e.Parent; }
  public BridgePlaceholderElement GetFirstChild(BridgePlaceholderElement e) { return e.Children.Count==0?null:e.Children[0]; }
  public BridgePlaceholderElement GetNextSibling(BridgePlaceholderElement e) {
    if(e.Parent==null) return null; int i=e.Parent.Children.IndexOf(e)+1;
    return i>=e.Parent.Children.Count?null:e.Parent.Children[i];
  }
}
public static class BridgePlaceholderRegression {
  public static readonly string Group="Group", Text="Text", Button="Button", Image="Image", TextPattern="text", ValuePattern="value";
  public static readonly BridgePlaceholderWalker RawViewWalker=new BridgePlaceholderWalker();
}
`;
const assertions = String.raw`
function Check-BoundForeground { }
function Find-Composer { return $script:FreshEditor }
function Get-ComposerLayoutBody($Unused) { $script:LayoutQueries++; if($script:ChangedLayout -and $script:LayoutQueries -gt 1){ return $script:OtherLayout }; return $script:Layout }
function Test-ObservedEmptyComposerLayout($UnusedLayout,$UnusedComposer) { return -not $script:Attached }
function Reset-PlaceholderCase {
  $script:WindowElement=New-Object BridgePlaceholderElement(100,'window','Window','',$null)
  $script:Layout=New-Object BridgePlaceholderElement(200,'_ComposerLayoutBody_observed','Group','',$script:WindowElement)
  $script:OtherLayout=New-Object BridgePlaceholderElement(201,'_ComposerLayoutBody_observed','Group','',$script:WindowElement)
  $script:Editor=New-Object BridgePlaceholderElement(300,'ProseMirror','Edit','observed-placeholder',$script:Layout)
  $script:Placeholder=New-Object BridgePlaceholderElement(301,'placeholder','Group','',$script:Editor)
  $script:LabelGroup=New-Object BridgePlaceholderElement(302,'','Group','',$script:Placeholder)
  $script:Break=New-Object BridgePlaceholderElement(303,'ProseMirror-trailingBreak','Text',"` + '`n' + String.raw`",$script:Placeholder)
  $script:Label=New-Object BridgePlaceholderElement(304,'','Text','observed-placeholder',$script:LabelGroup)
  $script:Editor.Value.Current.Value=$script:Editor.Current.Name+"` + '`n' + String.raw`"
  $script:Editor.Text.DocumentRange.Text=$script:Editor.Current.Name+"` + '`n' + String.raw`"
  $script:FreshEditor=$script:Editor; $script:Attached=$false; $script:ChangedLayout=$false; $script:LayoutQueries=0
}
function Require-Placeholder([bool]$Expected) {
  $actual=Test-EmptyPlaceholderComposer $script:Editor
  if($actual -ne $Expected) { throw 'placeholder classification regression failed' }
  $script:Checks++
}
$script:Checks=0
Reset-PlaceholderCase; Require-Placeholder $true
Reset-PlaceholderCase; $script:Placeholder.Current.ClassName=''; Require-Placeholder $false
Reset-PlaceholderCase; $script:Placeholder.Current.Name='unknown'; Require-Placeholder $false
Reset-PlaceholderCase; $script:Placeholder.Current.ControlType='Text'; Require-Placeholder $false
Reset-PlaceholderCase; $null=New-Object BridgePlaceholderElement(305,'','Group','real text',$script:Editor); Require-Placeholder $false
Reset-PlaceholderCase; $null=New-Object BridgePlaceholderElement(306,'','Text','real text',$script:Placeholder); Require-Placeholder $false
Reset-PlaceholderCase; $null=New-Object BridgePlaceholderElement(307,'','Text','real text',$script:LabelGroup); Require-Placeholder $false
Reset-PlaceholderCase; $script:Label.Current.Name='different'; Require-Placeholder $false
Reset-PlaceholderCase; $script:Label.Current.ClassName='real-content'; Require-Placeholder $false
Reset-PlaceholderCase; $script:Break.Current.Name="` + '`n`n' + String.raw`"; Require-Placeholder $false
Reset-PlaceholderCase; $script:Break.Current.ClassName='real-break'; Require-Placeholder $false
Reset-PlaceholderCase; $null=New-Object BridgePlaceholderElement(308,'','Text','real text',$script:Break); Require-Placeholder $false
Reset-PlaceholderCase; $script:Editor.Value.Current.Value='real draft'; Require-Placeholder $false
Reset-PlaceholderCase; $script:Editor.Text.DocumentRange.Text='real draft'; Require-Placeholder $false
Reset-PlaceholderCase; $script:Editor.Value.Current.IsReadOnly=$true; Require-Placeholder $false
Reset-PlaceholderCase; $script:Editor.HasText=$false; Require-Placeholder $false
Reset-PlaceholderCase; $script:Label.Current.ProcessId=999; Require-Placeholder $false
Reset-PlaceholderCase; $script:Label.Current.IsKeyboardFocusable=$true; Require-Placeholder $false
Reset-PlaceholderCase; $script:Label.Parent=$null; Require-Placeholder $false
Reset-PlaceholderCase; $script:Attached=$true; Require-Placeholder $false
Reset-PlaceholderCase; $script:ChangedLayout=$true; Require-Placeholder $false
Reset-PlaceholderCase; $script:FreshEditor=New-Object BridgePlaceholderElement(399,'ProseMirror','Edit','observed-placeholder',$script:Layout); Require-Placeholder $false
`;
const layoutAssertions = String.raw`
function Check-Deadline { }
function Add-ObservedNode([int]$Id,[string]$Class,[string]$Type,$Parent) {
  $node=New-Object BridgePlaceholderElement($Id,$Class,$Type,'',$Parent)
  if($Type -ceq 'Button'){ $node.Current.IsKeyboardFocusable=$true }
  return $node
}
function Reset-EmptyLayoutCase {
  Reset-PlaceholderCase
  $script:AddGroup=Add-ObservedNode 400 'contents' 'Group' $script:Layout
  $script:AddButton=Add-ObservedNode 401 'h-token-button-composer aspect-square !px-0' 'Button' $script:AddGroup
  $script:Permission=Add-ObservedNode 402 'h-token-button-composer min-w-token-button-composer px-1.5' 'Button' $script:Layout
  $null=Add-ObservedNode 403 'icon-xs shrink-0 text-warning' 'Image' $script:Permission
  $label=Add-ObservedNode 404 '_ComposerDropdownLabelValueContent_observed' 'Group' $script:Permission
  $script:PermissionLabel=Add-ObservedNode 405 '' 'Text' $label
  $script:ModelGroup=Add-ObservedNode 406 'contents' 'Group' $script:Layout
  $script:ModelButton=Add-ObservedNode 407 'h-token-button-composer min-w-0 px-2' 'Button' $script:ModelGroup
  $script:DictationGroup=Add-ObservedNode 408 'contents' 'Group' $script:Layout
  $button=Add-ObservedNode 409 'h-token-button-composer aspect-square !px-0' 'Button' $script:DictationGroup
  $script:DictationIcon=Add-ObservedNode 410 'icon-leading text-default' 'Image' $button
  $script:VoiceGroup=Add-ObservedNode 411 'contents' 'Group' $script:Layout
  $script:VoiceButton=Add-ObservedNode 412 'size-token-button-composer bg-composer-primary' 'Button' $script:VoiceGroup
}
function Require-EmptyLayout([bool]$Expected) {
  $actual=Test-ObservedEmptyComposerLayout $script:Layout $script:Editor
  if($actual -ne $Expected) { throw 'closed empty layout regression failed' }
  $script:Checks++
}
Reset-EmptyLayoutCase; Require-EmptyLayout $true
Reset-EmptyLayoutCase; $null=Add-ObservedNode 450 'attachment' 'Group' $script:Layout; Require-EmptyLayout $false
Reset-EmptyLayoutCase; $null=Add-ObservedNode 451 'attachment-image' 'Image' $script:AddButton; Require-EmptyLayout $false
Reset-EmptyLayoutCase; $script:Permission.Current.Name='Send'; Require-EmptyLayout $false
Reset-EmptyLayoutCase; $script:VoiceButton.Current.Name='Send'; Require-EmptyLayout $false
Reset-EmptyLayoutCase; $script:VoiceButton.Current.IsOffscreen=$true; Require-EmptyLayout $false
Reset-EmptyLayoutCase; $script:VoiceButton.Current.IsEnabled=$false; Require-EmptyLayout $false
Reset-EmptyLayoutCase; $null=Add-ObservedNode 452 'ProseMirror' 'Edit' $script:Layout; Require-EmptyLayout $false
Reset-EmptyLayoutCase; $script:AddButton.Current.ProcessId=999; Require-EmptyLayout $false
Reset-EmptyLayoutCase; $script:VoiceButton.Parent=$script:OtherLayout; Require-EmptyLayout $false
Reset-EmptyLayoutCase; $script:DictationIcon.Current.ClassName='attachment-image'; Require-EmptyLayout $false
Reset-EmptyLayoutCase; $null=Add-ObservedNode 453 '' 'Text' $script:PermissionLabel; Require-EmptyLayout $false
Reset-EmptyLayoutCase; $script:ModelGroup.Current.ClassName='attachment'; Require-EmptyLayout $false
Reset-EmptyLayoutCase; $null=Add-ObservedNode 454 '' 'Text' $script:ModelButton; Require-EmptyLayout $false
Reset-EmptyLayoutCase; $script:ModelButton.Current.ClassName='h-token-button-composer px-2'; Require-EmptyLayout $false
[Console]::Out.WriteLine($script:Checks)
`;
const command = "$ErrorActionPreference='Stop';\nAdd-Type -TypeDefinition @'\n" + mockTypes + "\n'@\n" +
  functionSource('Runtime-IdsEqual') + '\n' + functionSource('Element-IsInBoundWindow') + '\n' +
  functionSource('Test-EmptyPlaceholderComposer') + '\n' + assertions + '\n' +
  functionSource('Test-ObservedEmptyComposerLayout') + '\n' + layoutAssertions;
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
// The actual closed-tree validator exceeds Windows' argv limit after UTF-16
// base64 encoding. Keep the short-lived test source beside this D: workspace.
const temporaryDirectory = fs.mkdtempSync(path.join(path.dirname(path.dirname(__dirname)), 'native-placeholder-regression-'));
const temporaryScript = path.join(temporaryDirectory, 'check.ps1');
const nativeTemp = path.join(path.dirname(__dirname), 'logs', 'native-temp');
fs.mkdirSync(nativeTemp, { recursive: true });
let result;
try {
  fs.writeFileSync(temporaryScript, '\uFEFF' + command, 'utf8');
  result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', temporaryScript], { encoding: 'utf8', windowsHide: true, timeout: 10000,
    env: { ...process.env, TEMP: nativeTemp, TMP: nativeTemp } });
} finally {
  fs.unlinkSync(temporaryScript);
  fs.rmdirSync(temporaryDirectory);
}
assert.equal(result.status, 0, result.stderr || 'Production placeholder regression failed.');
assert.equal(Number(result.stdout.trim()), 37);
console.log('PASS 37 production PowerShell placeholder/layout regressions with a simulated UIA tree; no desktop actions.');
