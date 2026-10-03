'use strict';
// Run the complete read-only source guard on synthetic UIA trees. The target
// send driver is loaded only as an AST; no desktop, input or clipboard APIs run.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { spawnSync } = require('node:child_process');
if (process.platform !== 'win32') { console.log('SKIP Windows source guard regression.'); process.exit(0); }
const sourceGuard = fs.readFileSync(path.join(__dirname, 'codex-desktop-source-guard.ps1'), 'utf8');
const nativeDriver = fs.readFileSync(path.join(__dirname, 'codex-desktop-ui.ps1'), 'utf8');
const outgoingSourceGuard = nativeDriver.match(/    function Protect-OutgoingDesktopDraft \{[\s\S]+?(?=\r?\n    function Find-Composer)/)?.[0];
assert.ok(outgoingSourceGuard, 'The production outgoing-source guard must be present.');
function mockTypes(source) {
  return source.replaceAll('[Windows.Automation.TreeWalker]::RawViewWalker', '[SourceGuardFixture]::Walker')
    .replaceAll('[Windows.Automation.AutomationElement]::ControlTypeProperty', "'ControlType'")
    .replaceAll('Windows.Automation.PropertyCondition', 'SourceGuardCondition')
    .replaceAll('[Windows.Automation.TreeScope]::Descendants', "'Descendants'")
    .replaceAll('[Windows.Automation.TextPattern]::IsReadOnlyAttribute', "'ReadOnly'")
    .replaceAll('[Windows.Automation.TextPattern]::Pattern', '[SourceGuardFixture]::TextPattern')
    .replaceAll('[Windows.Automation.ValuePattern]::Pattern', '[SourceGuardFixture]::ValuePattern')
    .replace(/\[Windows\.Automation\.ControlType\]::(Window|Group|Edit|Text|Button|Image)/g, "'$1'");
}
const types = String.raw`
using System;
using System.Collections.Generic;
public sealed class SourceGuardProperties {
  public string ClassName, ControlType, Name; public int ProcessId=123;
  public bool IsKeyboardFocusable,IsPassword,IsOffscreen; public bool IsEnabled=true;
}
public sealed class SourceGuardValueProperties {public bool IsReadOnly; public string Value;}
public sealed class SourceGuardValue {public SourceGuardValueProperties Current=new SourceGuardValueProperties();}
public sealed class SourceGuardRange {public string Text; public string GetText(int n){return Text;} public object GetAttributeValue(object a){return false;}}
public sealed class SourceGuardText {public SourceGuardRange DocumentRange=new SourceGuardRange();}
public sealed class SourceGuardCondition {public object Value; public SourceGuardCondition(object p,object v){Value=v;}}
public sealed class SourceGuardNode {
  public int Id; public SourceGuardNode Parent; public SourceGuardProperties Current;
  public List<SourceGuardNode> Children=new List<SourceGuardNode>();
  public SourceGuardValue Value=new SourceGuardValue(); public SourceGuardText Text=new SourceGuardText();
  public bool HasValue=true,HasText=true;
  public SourceGuardNode(int id,string type,string cls,string name,SourceGuardNode parent){
    Id=id;Parent=parent;Current=new SourceGuardProperties{ControlType=type,ClassName=cls,Name=name};
    if(parent!=null)parent.Children.Add(this);
  }
  public int[] GetRuntimeId(){return new[]{42,Id};}
  public bool TryGetCurrentPattern(object p,out object v){v=null;if((string)p=="value"&&HasValue){v=Value;return true;}if((string)p=="text"&&HasText){v=Text;return true;}return false;}
  public SourceGuardNode[] FindAll(object scope,SourceGuardCondition c){
    SourceGuardFixture.RootQueries++;
    if(SourceGuardFixture.SwapAt>0&&SourceGuardFixture.RootQueries>=SourceGuardFixture.SwapAt)return new[]{SourceGuardFixture.OtherEditor};
    var all=new List<SourceGuardNode>();Collect(this,(string)c.Value,all);return all.ToArray();
  }
  private static void Collect(SourceGuardNode parent,string type,List<SourceGuardNode> result){foreach(var node in parent.Children){if(node.Current.ControlType==type)result.Add(node);Collect(node,type,result);}}
}
public sealed class SourceGuardWalker {
  public SourceGuardNode GetParent(SourceGuardNode e){return e.Parent;}
  public SourceGuardNode GetFirstChild(SourceGuardNode e){return e.Children.Count==0?null:e.Children[0];}
  public SourceGuardNode GetNextSibling(SourceGuardNode e){if(e.Parent==null)return null;int n=e.Parent.Children.IndexOf(e)+1;return n>=e.Parent.Children.Count?null:e.Parent.Children[n];}
}
public static class SourceGuardFixture {
  public static readonly string TextPattern="text",ValuePattern="value";
  public static readonly SourceGuardWalker Walker=new SourceGuardWalker();
  public static int RootQueries,SwapAt;public static SourceGuardNode OtherEditor;
}
`;
const assertions = String.raw`
function N([int]$Id,[string]$Type,[string]$Class,[string]$Name,$Parent) {
  $node=New-Object SourceGuardNode($Id,$Type,$Class,$Name,$Parent)
  if($Type -ceq 'Button' -or $Type -ceq 'Edit'){$node.Current.IsKeyboardFocusable=$true}
  return $node
}
function Reset-ActiveCase([string]$Language='zh') {
  $script:Root=N 100 'Window' 'verified-window' '' $null
  $script:Layout=N 200 'Group' '_ComposerLayoutBody_gcdh7_2' '' $script:Root
  $script:Editor=N 300 'Edit' 'ProseMirror ProseMirror-focused' 'observed-placeholder' $script:Layout
  $script:Placeholder=N 301 'Group' 'placeholder' '' $script:Editor
  $script:LabelGroup=N 302 'Group' '' '' $script:Placeholder
  $script:Break=N 303 'Text' 'ProseMirror-trailingBreak' ([string][char]10) $script:Placeholder
  $script:Break.Current.IsOffscreen=$true
  $script:Label=N 304 'Text' '' $script:Editor.Current.Name $script:LabelGroup
  $script:Editor.Value.Current.Value=$script:Editor.Current.Name+[char]10
  $script:Editor.Text.DocumentRange.Text=$script:Editor.Current.Name+[char]10
  # Independent synthetic layout: copied from the sanitized native observation,
  # never generated from the production predicate under test.
  $common='no-drag cursor-interaction items-center select-none disabled:cursor-default aria-disabled:cursor-default focus:outline-hidden disabled:opacity-40 aria-disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 whitespace-nowrap flex border gap-1 rounded-full text-tertiary not-disabled:not-aria-disabled:hover:bg-primary-ghost-hover data-[state=open]:bg-primary-ghost-hover border-transparent h-token-button-composer '
  $square=$common+'px-(--padding-button-composer-inline,calc(var(--spacing)*2)) py-0 text-(length:--text-button-composer,var(--text-sm)) leading-(--line-height-button-composer,18px) aspect-square shrink-0 items-center justify-center !px-0'
  if($Language -ceq 'en'){$names=@('Add files and more','Change permissions','Select model','Dictate','Stop')}
  else{$names=@((-join [char[]]@(0x6DFB,0x52A0,0x6587,0x4EF6,0x7B49,0x5185,0x5BB9)),(-join [char[]]@(0x66F4,0x6539,0x6743,0x9650)),(-join [char[]]@(0x9009,0x62E9,0x6A21,0x578B)),(-join [char[]]@(0x542C,0x5199)),(-join [char[]]@(0x505C,0x6B62)))}
  $script:AddGroup=N 400 'Group' 'contents' '' $script:Layout
  $script:AddButton=N 401 'Button' $square $names[0] $script:AddGroup
  $script:Permission=N 402 'Button' ($common+'min-w-token-button-composer justify-center px-1.5 py-0 text-sm leading-[18px] outline-hidden cursor-interaction') $names[1] $script:Layout
  $script:PermissionIcon=N 403 'Image' 'icon-xs shrink-0 text-warning' '' $script:Permission
  $script:ModelGroup=N 404 'Group' 'contents outline-hidden cursor-interaction' '' $script:Layout
  $script:ModelButton=N 405 'Button' ($common+'px-2 py-0 text-sm leading-[18px] aspect-square shrink-0 items-center justify-center !px-0 min-w-0') $names[2] $script:ModelGroup
  $script:ModelIcon=N 406 'Image' 'icon-leading text-tertiary' '' $script:ModelButton
  $script:DictationGroup=N 407 'Group' 'contents' '' $script:Layout
  $script:DictationButton=N 408 'Button' $square $names[3] $script:DictationGroup
  $script:DictationIcon=N 409 'Image' 'icon-leading text-default' '' $script:DictationButton
  $script:Stop=N 410 'Button' 'cursor-interaction size-token-button-composer flex items-center justify-center rounded-full transition-opacity focus-visible:outline-2 bg-composer-primary p-0.5 focus-visible:outline-background-composer-primary' $names[4] $script:Layout
  $script:StopIcon=N 411 'Image' 'icon-primary-action text-composer-primary' '' $script:Stop
  [SourceGuardFixture]::RootQueries=0;[SourceGuardFixture]::SwapAt=0
  [SourceGuardFixture]::OtherEditor=N 999 'Edit' 'ProseMirror' 'different-editor' $null
}
function Reset-ExpandedActiveCase([string]$Language='zh') {
  # Independently encode the observed 19-node expanded ACTIVE tree. The diff
  # summary is a sibling of this composer body and carries no source authority.
  Reset-ActiveCase $Language
  $script:Editor.Current.Name=(-join [char[]]@(0x968F,0x5FC3,0x8F93,0x5165))
  $script:Label.Current.Name=$script:Editor.Current.Name
  $script:Editor.Value.Current.Value=$script:Editor.Current.Name+[char]10
  $script:Editor.Text.DocumentRange.Text=$script:Editor.Current.Name+[char]10
  $script:Break.Current.IsOffscreen=$false
  $script:PermissionLabelGroup=N 412 'Group' '_ComposerDropdownLabelValueContent_gjskc_105' '' $script:Permission
  $label=if($Language -ceq 'en'){'Full access'}else{-join [char[]]@(0x5B8C,0x5168,0x8BBF,0x95EE)}
  $script:PermissionLabel=N 413 'Text' '' $label $script:PermissionLabelGroup
  $script:ModelGroup.Current.ClassName='contents'
  $script:ModelButton.Current.ClassName='no-drag cursor-interaction items-center select-none disabled:cursor-default aria-disabled:cursor-default focus:outline-hidden disabled:opacity-40 aria-disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 whitespace-nowrap flex border gap-1 rounded-full text-tertiary not-disabled:not-aria-disabled:hover:bg-primary-ghost-hover data-[state=open]:bg-primary-ghost-hover border-transparent h-token-button-composer px-2 py-0 text-sm leading-[18px] min-w-0'
  $script:ModelButton.Current.Name='GPT-6.1 Sol Ultra'
  $script:ModelButton.Children.Clear()
  $script:ModelIcon.Parent=$null
  $nodes=New-Object Collections.Generic.Queue[object]
  $nodes.Enqueue($script:Layout);$count=0
  while($nodes.Count){$node=$nodes.Dequeue();$count++;foreach($child in $node.Children){$nodes.Enqueue($child)}}
  if($count -ne 19){throw 'Expanded source fixture must retain the observed 19-node tree.'}
}
function Reset-ObservedCompactWrapperCase([string]$Language='zh') {
  # Independently encode the fresh 18-node source observation: an unfocused
  # empty editor, compact settings and one offscreen structural dictation
  # wrapper whose exact child button/icon remain enabled and onscreen.
  Reset-ActiveCase $Language
  $script:Editor.Current.ClassName='ProseMirror'
  $script:Editor.Current.Name=(-join [char[]]@(0x968F,0x5FC3,0x8F93,0x5165))
  $script:Label.Current.Name=$script:Editor.Current.Name
  $script:Editor.Value.Current.Value=$script:Editor.Current.Name+[char]10
  $script:Editor.Text.DocumentRange.Text=$script:Editor.Current.Name+[char]10
  $script:DictationGroup.Current.IsOffscreen=$true
  $nodes=New-Object Collections.Generic.Queue[object]
  $nodes.Enqueue($script:Layout);$count=0
  while($nodes.Count){$node=$nodes.Dequeue();$count++;foreach($child in $node.Children){$nodes.Enqueue($child)}}
  if($count -ne 18){throw 'Observed compact source fixture must retain the 18-node tree.'}
}
function Require-Source([bool]$Expected,[string]$Version='26.928.3736.0',[bool]$Known=$true) {
  $actual=Test-PocketBridgeCodexBlankSource $script:Editor $script:Root $Version $Known
  if($actual -ne $Expected){throw ('source guard regression failed, case '+$script:Checks)}
  $script:Checks++
}
$script:Checks=0
Reset-ActiveCase;Require-Source $true
Reset-ActiveCase 'en';Require-Source $true
Reset-ActiveCase;Require-Source $false '26.928.3736.1'
Reset-ActiveCase;Require-Source $false '26.928.3736.0' $false
Reset-ActiveCase;$script:Root.Current.IsOffscreen=$true;Require-Source $false
Reset-ActiveCase;$script:Root.Current.ControlType='Group';Require-Source $false
Reset-ActiveCase;$script:Editor.Current.ProcessId=999;Require-Source $false
Reset-ActiveCase;$script:Editor.Current.IsPassword=$true;Require-Source $false
Reset-ActiveCase;$script:Editor.Current.IsOffscreen=$true;Require-Source $false
Reset-ActiveCase;$script:Editor.Value.Current.IsReadOnly=$true;Require-Source $false
Reset-ActiveCase;$script:Editor.HasValue=$false;Require-Source $false
Reset-ActiveCase;$script:Editor.HasText=$false;Require-Source $false
Reset-ActiveCase;$script:Editor.Value.Current.Value='real draft';Require-Source $false
Reset-ActiveCase;$script:Editor.Text.DocumentRange.Text='real draft';Require-Source $false
Reset-ActiveCase;$script:Placeholder.Current.ClassName='';Require-Source $false
Reset-ActiveCase;$script:Label.Current.Name='other words';Require-Source $false
Reset-ActiveCase;$script:Label.Current.IsKeyboardFocusable=$true;Require-Source $false
Reset-ActiveCase;$script:Break.Current.Name=[string][char]10+[char]10;Require-Source $false
Reset-ActiveCase;$null=N 500 'Text' '' 'typed text' $script:Editor;Require-Source $false
Reset-ActiveCase;$null=N 501 'Text' '' 'literal placeholder' $script:LabelGroup;Require-Source $false
Reset-ActiveCase;$null=N 502 'Group' 'attachment' '' $script:Layout;Require-Source $false
Reset-ActiveCase;$null=N 503 'Image' 'attachment' '' $script:AddButton;Require-Source $false
Reset-ActiveCase;$null=N 504 'Text' '' '' $script:StopIcon;Require-Source $false
Reset-ActiveCase;$script:Stop.Current.Name='Send';Require-Source $false
Reset-ActiveCase;$script:Stop.Current.Name=(-join [char[]]@(0x53D1,0x9001));Require-Source $false
Reset-ActiveCase;$script:Stop.Current.Name='Stop task elsewhere';Require-Source $false
Reset-ActiveCase;$script:Stop.Current.IsEnabled=$false;Require-Source $false
Reset-ActiveCase;$script:Stop.Current.IsOffscreen=$true;Require-Source $false
Reset-ActiveCase;$script:Stop.Current.IsKeyboardFocusable=$false;Require-Source $false
Reset-ActiveCase;$script:StopIcon.Current.ClassName='attachment-image';Require-Source $false
Reset-ActiveCase;$script:PermissionIcon.Current.ProcessId=999;Require-Source $false
Reset-ActiveCase;$script:PermissionIcon.Parent=$script:AddButton;Require-Source $false
Reset-ActiveCase;$script:ModelGroup.Current.ClassName='contents';Require-Source $false
Reset-ActiveCase;$script:ModelIcon.Current.Name='unknown attachment';Require-Source $false
Reset-ActiveCase;$script:ModelButton.Current.Name='Send';Require-Source $false
Reset-ActiveCase;$null=N 505 'Group' 'label' '' $script:Permission;Require-Source $false
Reset-ActiveCase;$script:Layout.Current.ClassName='_ComposerLayoutBody_other';Require-Source $false
Reset-ActiveCase;$script:AddGroup.Current.IsKeyboardFocusable=$true;Require-Source $false
Reset-ActiveCase;$script:Editor.Current.ClassName='ProseMirror lookalike';Require-Source $false
Reset-ActiveCase;[SourceGuardFixture]::SwapAt=2;Require-Source $false
Reset-ActiveCase;$null=N 506 'Edit' 'ProseMirror' 'extra-editor' $script:Layout;Require-Source $false
Reset-ExpandedActiveCase;Require-Source $true
Reset-ExpandedActiveCase 'en';Require-Source $true
Reset-ExpandedActiveCase;$script:ModelButton.Current.Name='GPT-6 Astra High';Require-Source $true
Reset-ExpandedActiveCase;$script:PermissionLabel.Current.Name='Default permissions';Require-Source $true
Reset-ExpandedActiveCase;$null=N 600 'Group' 'diff-summary' '4 files changed +49 -1' $script:Root;Require-Source $true
Reset-ExpandedActiveCase;Require-Source $false '26.928.3736.1'
Reset-ExpandedActiveCase;Require-Source $false '26.928.3736.0' $false
Reset-ExpandedActiveCase;$script:Editor.Value.Current.Value='real draft';Require-Source $false
Reset-ExpandedActiveCase;$script:Editor.Text.DocumentRange.Text='real draft';Require-Source $false
Reset-ExpandedActiveCase;$null=N 601 'Text' '' 'typed text' $script:Editor;Require-Source $false
Reset-ExpandedActiveCase;$null=N 602 'Group' 'attachment' '' $script:Layout;Require-Source $false
Reset-ExpandedActiveCase;$null=N 603 'Image' 'attachment' '' $script:AddButton;Require-Source $false
Reset-ExpandedActiveCase;$null=N 604 'Edit' 'ProseMirror' 'extra-editor' $script:Layout;Require-Source $false
Reset-ExpandedActiveCase;[SourceGuardFixture]::SwapAt=2;Require-Source $false
Reset-ExpandedActiveCase;$script:PermissionLabelGroup.Current.ClassName='_ComposerDropdownLabelValueContent_unknown';Require-Source $false
Reset-ExpandedActiveCase;$script:PermissionLabelGroup.Current.Name='unexpected content';Require-Source $false
Reset-ExpandedActiveCase;$script:PermissionLabelGroup.Current.IsKeyboardFocusable=$true;Require-Source $false
Reset-ExpandedActiveCase;$script:PermissionLabelGroup.Current.IsOffscreen=$true;Require-Source $false
Reset-ExpandedActiveCase;$script:PermissionLabel.Current.ClassName='attachment';Require-Source $false
Reset-ExpandedActiveCase;$script:PermissionLabel.Current.IsKeyboardFocusable=$true;Require-Source $false
Reset-ExpandedActiveCase;$script:PermissionLabel.Current.ProcessId=999;Require-Source $false
Reset-ExpandedActiveCase;$script:PermissionLabel.Parent=$script:ModelGroup;Require-Source $false
Reset-ExpandedActiveCase;$script:PermissionLabel.Current.Name='Send';Require-Source $false
Reset-ExpandedActiveCase;$null=N 605 'Text' '' 'second setting label' $script:PermissionLabelGroup;Require-Source $false
Reset-ExpandedActiveCase;$null=N 606 'Image' 'attachment' '' $script:PermissionLabel;Require-Source $false
Reset-ExpandedActiveCase;$script:ModelGroup.Current.ClassName='contents outline-hidden cursor-interaction';Require-Source $false
Reset-ExpandedActiveCase;$script:ModelButton.Current.Name='Send';Require-Source $false
Reset-ExpandedActiveCase;$script:ModelButton.Current.Name=(-join [char[]]@(0x53D1,0x9001));Require-Source $false
Reset-ExpandedActiveCase;$script:ModelButton.Current.ClassName+=' extra-control';Require-Source $false
Reset-ExpandedActiveCase;$null=N 607 'Image' 'icon-leading text-tertiary' '' $script:ModelButton;Require-Source $false
Reset-ExpandedActiveCase;$script:ModelButton.Current.IsEnabled=$false;Require-Source $false
Reset-ExpandedActiveCase;$script:Stop.Current.Name='Send';Require-Source $false
Reset-ExpandedActiveCase;$script:Stop.Current.ControlType='Group';Require-Source $false
Reset-ExpandedActiveCase;$script:Stop.Current.IsOffscreen=$true;Require-Source $false
Reset-ExpandedActiveCase;$script:StopIcon.Current.ClassName='attachment-image';Require-Source $false
Reset-ExpandedActiveCase;$script:Stop.Children.Clear();Require-Source $false
Reset-ExpandedActiveCase;$null=N 608 'Text' '' 'unrecognized child' $script:StopIcon;Require-Source $false
Reset-ExpandedActiveCase;$script:Layout.Current.Name='unexpected content';Require-Source $false
Reset-ObservedCompactWrapperCase;Require-Source $true
Reset-ObservedCompactWrapperCase 'en';Require-Source $true
Reset-ObservedCompactWrapperCase;$script:DictationButton.Current.IsOffscreen=$true;Require-Source $false
Reset-ObservedCompactWrapperCase;$script:DictationIcon.Current.IsOffscreen=$true;Require-Source $false
Reset-ObservedCompactWrapperCase;$script:DictationButton.Current.IsEnabled=$false;Require-Source $false
Reset-ObservedCompactWrapperCase;$script:DictationIcon.Current.IsEnabled=$false;Require-Source $false
Reset-ObservedCompactWrapperCase;$script:DictationGroup.Current.IsEnabled=$false;Require-Source $false
Reset-ObservedCompactWrapperCase;$script:DictationGroup.Current.IsKeyboardFocusable=$true;Require-Source $false
Reset-ObservedCompactWrapperCase;$script:DictationGroup.Current.Name='unexpected content';Require-Source $false
Reset-ObservedCompactWrapperCase;$script:DictationGroup.Current.ClassName='contents other-wrapper';Require-Source $false
Reset-ObservedCompactWrapperCase;$script:DictationGroup.Current.ControlType='Button';Require-Source $false
Reset-ObservedCompactWrapperCase;$script:DictationGroup.Current.ProcessId=999;Require-Source $false
Reset-ObservedCompactWrapperCase;$script:DictationGroup.Parent=$script:AddGroup;Require-Source $false
Reset-ObservedCompactWrapperCase;$script:AddGroup.Current.IsOffscreen=$true;Require-Source $false
Reset-ObservedCompactWrapperCase;$script:ModelGroup.Current.IsOffscreen=$true;Require-Source $false
Reset-ObservedCompactWrapperCase;$script:PermissionIcon.Current.IsOffscreen=$true;Require-Source $false
Reset-ObservedCompactWrapperCase;$script:StopIcon.Current.IsOffscreen=$true;Require-Source $false
Reset-ObservedCompactWrapperCase;$script:Layout.Current.IsOffscreen=$true;Require-Source $false
Reset-ObservedCompactWrapperCase;$script:Editor.Current.IsOffscreen=$true;Require-Source $false
Reset-ObservedCompactWrapperCase;$script:DictationButton.Current.Name='Send';Require-Source $false
Reset-ObservedCompactWrapperCase;$null=N 611 'Group' 'attachment' '' $script:Layout;Require-Source $false
Reset-ObservedCompactWrapperCase;$null=N 612 'Text' '' 'extra wrapper content' $script:DictationGroup;Require-Source $false
Reset-ObservedCompactWrapperCase;$null=N 613 'Image' 'attachment' '' $script:DictationButton;Require-Source $false
Reset-ObservedCompactWrapperCase;$script:Editor.Value.Current.Value='real draft';Require-Source $false
Reset-ExpandedActiveCase;$script:DictationGroup.Current.IsOffscreen=$true;Require-Source $false
function Check-BoundForeground {}
function Get-DesktopModeControls($Root) { return @([pscustomobject]@{Current=[pscustomobject]@{Name='Switch mode, current mode: Codex'}}) }
function Get-DesktopModeKind([string]$Name) { if($Name -ceq 'Switch mode, current mode: Codex'){return 'codex'};return $null }
function Get-CodexComposerCandidates($Root) { return @($script:Editor) }
function Get-ComposerText($Element) { $script:SelectionReads++; throw 'Native selection must not be read by the blank outgoing-source proof.' }
function Require-OutgoingSource([bool]$Expected) {
  $script:WindowElement=$script:Root
  $script:Desktop=[pscustomobject]@{Package=[pscustomobject]@{Version='26.928.3736.0'}}
  $script:SelectionReads=0;$passed=$true
  try{Protect-OutgoingDesktopDraft}catch{
    if($_.Exception.Message -cne 'source-proof-unavailable' -and -not $_.Exception.Message.StartsWith('draft-present|')){throw}
    $passed=$false
  }
  if($passed -ne $Expected -or $script:SelectionReads -ne 0){throw ('outgoing source regression failed, case '+$script:Checks)}
  $script:Checks++
}
function Fail-Relay([string]$Code,[string]$Reason) { throw ($Code+'|'+$Reason) }
Reset-ActiveCase;Require-OutgoingSource $true
Reset-ActiveCase 'en';Require-OutgoingSource $true
Reset-ActiveCase;$script:Editor.Value.Current.Value='real draft';Require-OutgoingSource $false
Reset-ActiveCase;$null=N 507 'Group' 'attachment' '' $script:Layout;Require-OutgoingSource $false
Reset-ExpandedActiveCase;Require-OutgoingSource $true
Reset-ExpandedActiveCase 'en';Require-OutgoingSource $true
Reset-ExpandedActiveCase;$script:Editor.Value.Current.Value='real draft';Require-OutgoingSource $false
Reset-ExpandedActiveCase;$script:Editor.Text.DocumentRange.Text='real draft';Require-OutgoingSource $false
Reset-ExpandedActiveCase;$null=N 609 'Group' 'attachment' '' $script:Layout;Require-OutgoingSource $false
Reset-ExpandedActiveCase;$null=N 610 'Edit' 'ProseMirror' 'extra-editor' $script:Layout;Require-OutgoingSource $false
Reset-ObservedCompactWrapperCase;Require-OutgoingSource $true
Reset-ObservedCompactWrapperCase;$script:DictationButton.Current.IsOffscreen=$true;Require-OutgoingSource $false
Reset-ObservedCompactWrapperCase;$null=N 614 'Group' 'attachment' '' $script:Layout;Require-OutgoingSource $false
[Console]::Out.WriteLine($script:Checks)
`;
const isolated = fs.mkdtempSync(path.join(process.env.DOT_JOURNAL_TEST_DIRECTORY || path.join(__dirname, '..', 'logs'), 'source-guard-fixture-'));
const command = "$ErrorActionPreference='Stop';\nAdd-Type -TypeDefinition @'\n" + types + "\n'@\n" + mockTypes(sourceGuard) + '\n' + mockTypes(outgoingSourceGuard) + '\n' + assertions;
let result;
try {
  fs.writeFileSync(path.join(isolated, 'codex-desktop-ui.ps1'), '\uFEFF' + mockTypes(nativeDriver), 'utf8');
  fs.writeFileSync(path.join(isolated, 'codex-desktop-source-guard.ps1'), '\uFEFF' + mockTypes(sourceGuard), 'utf8');
  fs.writeFileSync(path.join(isolated, 'check.ps1'), '\uFEFF' + command, 'utf8');
  result = spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(isolated, 'check.ps1')],
    { encoding: 'utf8', windowsHide: true, timeout: 45000, env: { ...process.env, TEMP: isolated, TMP: isolated } });
} finally {
  // Remove only the three known synthetic inputs/compile outputs, never recurse.
  for (const name of ['codex-desktop-ui.ps1','codex-desktop-source-guard.ps1','check.ps1']) fs.unlinkSync(path.join(isolated, name));
}
assert.equal(result.status, 0, result.stderr || result.error?.message || 'Source guard fixture failed.');
assert.equal(Number(result.stdout.trim()), 117);
console.log('PASS 117 complete source-only compact/expanded active, observed wrapper and outgoing relay guard regressions; native actions are synthetic.');
