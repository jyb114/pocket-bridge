'use strict';
// Exercise the production read-only process pin on an owned harmless child,
// and the exact production identity function with isolated CIM/native seams.
// No desktop windows, clipboard, UI input or installed Codex process is used.
const assert = require('node:assert/strict');
const fs = require('node:fs'),path = require('node:path');
const { spawnSync } = require('node:child_process');
if (process.platform !== 'win32') { console.log('SKIP Windows held-process identity regression.'); process.exit(0); }
const source = fs.readFileSync(path.join(__dirname,'codex-desktop-ui.ps1'),'utf8');
const native = source.match(/Add-Type -TypeDefinition @'\r?\n([\s\S]+?)\r?\n'@/);
assert.ok(native,'Production native declarations are present.');
const mocks = String.raw`
public sealed class ProcessIdentityMockPin {
  public uint Id; public bool Disposed;
  public void Capture(uint id,string path){ProcessIdentityFixture.Events.Add("capture");ProcessIdentityFixture.CaptureCalls++;if(ProcessIdentityFixture.FailCapture||id!=Id||Disposed)throw new System.InvalidOperationException("capture refused");}
  public void Verify(uint id,string path){ProcessIdentityFixture.Events.Add("verify");ProcessIdentityFixture.VerifyCalls++;if(ProcessIdentityFixture.FailVerify||id!=Id||Disposed)throw new System.InvalidOperationException("verify refused");}
  public void Dispose(){ProcessIdentityFixture.Events.Add("dispose");ProcessIdentityFixture.DisposeCalls++;Disposed=true;}
}
public static class ProcessIdentityFixture {
  public static int OpenCalls,CaptureCalls,VerifyCalls,DisposeCalls;
  public static bool FailOpen,FailCapture,FailVerify;
  public static readonly System.Collections.Generic.List<string> Events=new System.Collections.Generic.List<string>();
  public static ProcessIdentityMockPin Open(uint id){Events.Add("open");OpenCalls++;if(FailOpen)throw new System.InvalidOperationException("open refused");return new ProcessIdentityMockPin{Id=id};}
  public static void Reset(){OpenCalls=CaptureCalls=VerifyCalls=DisposeCalls=0;FailOpen=FailCapture=FailVerify=false;Events.Clear();}
}
`;
const checks = String.raw`
$script:Checks=0
$script:DesktopProcessPins=@{}
function Require([bool]$Condition,[string]$Description){if(-not $Condition){throw ('Process identity regression: '+$Description)};$script:Checks++}
function Require-Throws([scriptblock]$Action,[string]$Description){$threw=$false;try{& $Action}catch{$threw=$true};Require $threw $Description}
function Check-Deadline {}
function Fail-Relay([string]$Code,[string]$Reason){throw ($Code+'|'+$Reason)}
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:PBI_SOURCE_FILE,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Production identity AST must parse.'}
$definitions=@($ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Check-ProcessIdentity'},$true))
if($definitions.Count -ne 1){throw 'Production identity definition must be unique.'}
$definition=[string]$definitions[0].Extent.Text
Invoke-Expression $definition
$owned=$null;$pin=$null;$uncaptured=$null
try{
  $start=New-Object Diagnostics.ProcessStartInfo
  $start.FileName=$env:PBI_NODE_EXE;$start.Arguments='-e "process.stdin.resume()"'
  $start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardInput=$true
  $owned=[Diagnostics.Process]::Start($start)
  $null=$owned.Handle
  $actual=Get-CimInstance Win32_Process -Filter ('ProcessId='+$owned.Id) -ErrorAction Stop
  Require ($null -ne $actual -and [int]$actual.ProcessId -eq $owned.Id) 'Owned child is the only native target.'
  $image=[IO.Path]::GetFullPath($actual.ExecutablePath)
  Require ([string]::Equals($image,[IO.Path]::GetFullPath($env:PBI_NODE_EXE),[StringComparison]::OrdinalIgnoreCase)) 'Owned executable identity matches.'
  $uncaptured=[BridgeDesktopProcessIdentity]::Open([uint32]$owned.Id)
  Require-Throws {$uncaptured.Verify([uint32]$owned.Id,$image)} 'Uncaptured pin has no identity authority.'
  Require-Throws {$uncaptured.Capture([uint32]($owned.Id+1),$image)} 'Actual held object rejects a different PID.'
  Require-Throws {$uncaptured.Capture([uint32]$owned.Id,$image+'-other')} 'Actual held object rejects a different image path.'
  $uncaptured.Capture([uint32]$owned.Id,$image)
  $uncaptured.Verify([uint32]$owned.Id,$image)
  Require $true 'Native capture and fresh verification succeed.'
  Require-Throws {$uncaptured.Capture([uint32]$owned.Id,$image)} 'A captured object cannot be silently repinned.'
  Require-Throws {$uncaptured.Verify([uint32]($owned.Id+1),$image)} 'Pinned PID mismatch fails.'
  Require-Throws {$uncaptured.Verify([uint32]$owned.Id,$image+'-other')} 'Pinned image mismatch fails.'
  $field=[BridgeDesktopProcessIdentity].GetField('creationFileTime',[Reflection.BindingFlags]'NonPublic,Instance')
  Require ($null -ne $field) 'Test addresses the actual full native creation identity.'
  $birth=[long]$field.GetValue($uncaptured)
  $field.SetValue($uncaptured,[long]($birth+1))
  Require-Throws {$uncaptured.Verify([uint32]$owned.Id,$image)} 'A one-tick native birth mismatch is rejected without precision tolerance.'
  $field.SetValue($uncaptured,$birth);$uncaptured.Verify([uint32]$owned.Id,$image)
  Require $true 'Restored full native identity verifies.'
  $uncaptured.Dispose()
  Require-Throws {$uncaptured.Verify([uint32]$owned.Id,$image)} 'Disposed/query-unavailable handles fail closed.'
  $expectedTicks=$actual.CreationDate.ToUniversalTime().Ticks
  $desktop=[pscustomobject]@{ExecutablePath=$image;Processes=@([pscustomobject]@{ProcessId=$owned.Id;CreationTicks=$expectedTicks;ExecutablePath=$image})}
  Check-ProcessIdentity $desktop $owned.Id
  Require ($script:DesktopProcessPins.Count -eq 1) 'Production bootstrap retains exactly one held object.'
  Require ($script:DesktopProcessPins[$owned.Id].CreationTicks -eq $expectedTicks) 'Public CIM birth identity stays exact and unchanged.'
  for($iteration=0;$iteration -lt 10;$iteration++){Check-ProcessIdentity $desktop $owned.Id}
  Require ($script:DesktopProcessPins.Count -eq 1) 'Repeated live checks retain the same continuous pin.'
  $desktop.Processes[0].CreationTicks=$expectedTicks+1
  Require-Throws {Check-ProcessIdentity $desktop $owned.Id} 'A changed discovered CIM birth is rejected exactly.'
  $desktop.Processes[0].CreationTicks=$expectedTicks
  $desktop.Processes[0].ExecutablePath=$image+'-other'
  Require-Throws {Check-ProcessIdentity $desktop $owned.Id} 'Changed expected record path is rejected.'
  $desktop.Processes[0].ExecutablePath=$image
  $desktop.ExecutablePath=$image+'-other';$desktop.Processes[0].ExecutablePath=$desktop.ExecutablePath
  Require-Throws {Check-ProcessIdentity $desktop $owned.Id} 'Changed desktop and expected path cannot reauthorize an old pin.'
  $desktop.ExecutablePath=$image;$desktop.Processes[0].ExecutablePath=$image
  $pin=$script:DesktopProcessPins[$owned.Id].Pin
  $nativeBirth=[long]$field.GetValue($pin);$field.SetValue($pin,[long]($nativeBirth+1))
  Require-Throws {Check-ProcessIdentity $desktop $owned.Id} 'Production cached branch freshly checks exact native birth.'
  $field.SetValue($pin,$nativeBirth)
  $owned.StandardInput.Close();Require ($owned.WaitForExit(3000)) 'Only the owned child exits gracefully.'
  Require-Throws {$pin.Verify([uint32]$owned.Id,$image)} 'Held process object signals after its owner exits.'
  Require-Throws {Check-ProcessIdentity $desktop $owned.Id} 'Production cached path cannot authorize an exited object or reuse its PID.'
}finally{
  foreach($entry in @($script:DesktopProcessPins.Values)){$entry.Pin.Dispose()};$script:DesktopProcessPins.Clear()
  if($null -ne $pin){$pin.Dispose()};if($null -ne $uncaptured){$uncaptured.Dispose()}
  if($null -ne $owned){try{$owned.StandardInput.Close()}catch{};if(-not $owned.HasExited){$owned.Kill();$null=$owned.WaitForExit(3000)};$owned.Dispose()}
}
Invoke-Expression ($definition.Replace('[BridgeDesktopProcessIdentity]::Open','[ProcessIdentityFixture]::Open'))
function Reset-Mock{
  foreach($entry in @($script:DesktopProcessPins.Values)){$entry.Pin.Dispose()};$script:DesktopProcessPins.Clear()
  [ProcessIdentityFixture]::Reset();$script:CimCalls=0;$script:ThrowCim=$false
  $script:MockTicks=[long]638000000000000000
  $script:MockPath='D:\fixture\official.exe'
  $script:Desktop=[pscustomobject]@{ExecutablePath=$script:MockPath;Processes=@([pscustomobject]@{ProcessId=4321;CreationTicks=$script:MockTicks;ExecutablePath=$script:MockPath})}
  $script:MockActual=[pscustomobject]@{ProcessId=4321;ExecutablePath=$script:MockPath;CreationDate=(New-Object DateTime($script:MockTicks,[DateTimeKind]::Utc))}
}
function Get-CimInstance([string]$ClassName,[string]$Filter,[string]$ErrorAction){
  $script:CimCalls++;[ProcessIdentityFixture]::Events.Add('cim')
  if([ProcessIdentityFixture]::OpenCalls -ne 1){throw 'CIM was not preceded by the held-object open.'}
  if($script:ThrowCim){throw 'CIM unavailable'}
  return $script:MockActual
}
Reset-Mock;Check-ProcessIdentity $script:Desktop 4321
Require (([ProcessIdentityFixture]::Events -join ',') -ceq 'open,cim,capture') 'Bootstrap opens before the original fresh CIM comparison and captures afterward.'
Require ($script:CimCalls -eq 1 -and [ProcessIdentityFixture]::OpenCalls -eq 1) 'Bootstrap queries CIM exactly once.'
Check-ProcessIdentity $script:Desktop 4321;Check-ProcessIdentity $script:Desktop 4321
Require ($script:CimCalls -eq 1 -and [ProcessIdentityFixture]::VerifyCalls -eq 2) 'Every repeated boundary verifies the held identity without a CIM lookup or skipped native check.'
Reset-Mock;[ProcessIdentityFixture]::FailOpen=$true;Require-Throws {Check-ProcessIdentity $script:Desktop 4321} 'Failed native open cannot fall back to a PID cache.'
Require ($script:CimCalls -eq 0 -and $script:DesktopProcessPins.Count -eq 0) 'Failed open grants no authority.'
Reset-Mock;$script:ThrowCim=$true;Require-Throws {Check-ProcessIdentity $script:Desktop 4321} 'Failed fresh CIM check remains fail closed.'
Require ([ProcessIdentityFixture]::DisposeCalls -eq 1 -and $script:DesktopProcessPins.Count -eq 0) 'CIM failure disposes the newly held object.'
Reset-Mock;$script:MockActual=$null;Require-Throws {Check-ProcessIdentity $script:Desktop 4321} 'Missing actual CIM record fails.'
Require ([ProcessIdentityFixture]::DisposeCalls -eq 1) 'Missing actual record does not leak the pin.'
Reset-Mock;$script:MockActual.ProcessId=4322;Require-Throws {Check-ProcessIdentity $script:Desktop 4321} 'Actual CIM PID mismatch fails.'
Reset-Mock;$script:MockActual.CreationDate=New-Object DateTime(($script:MockTicks+1),[DateTimeKind]::Utc);Require-Throws {Check-ProcessIdentity $script:Desktop 4321} 'Fresh original CIM birth comparison permits no tick tolerance.'
Require ([ProcessIdentityFixture]::CaptureCalls -eq 0 -and [ProcessIdentityFixture]::DisposeCalls -eq 1) 'Birth mismatch cannot capture or leak a native identity.'
Reset-Mock;$script:MockActual.ExecutablePath='D:\fixture\foreign.exe';Require-Throws {Check-ProcessIdentity $script:Desktop 4321} 'Fresh original CIM image mismatch fails.'
Reset-Mock;$script:MockActual.ExecutablePath=$null;Require-Throws {Check-ProcessIdentity $script:Desktop 4321} 'Unavailable actual image fails.'
Reset-Mock;[ProcessIdentityFixture]::FailCapture=$true;Require-Throws {Check-ProcessIdentity $script:Desktop 4321} 'Exit/query failure between CIM and capture fails.'
Require ([ProcessIdentityFixture]::DisposeCalls -eq 1 -and $script:DesktopProcessPins.Count -eq 0) 'Failed capture cannot install an entry.'
Reset-Mock;$script:Desktop.Processes=@();Require-Throws {Check-ProcessIdentity $script:Desktop 4321} 'Missing discovered process fails before open.'
Require ([ProcessIdentityFixture]::OpenCalls -eq 0) 'No discovered identity cannot open an untrusted PID.'
Reset-Mock;$script:Desktop.Processes=@($script:Desktop.Processes[0],$script:Desktop.Processes[0]);Require-Throws {Check-ProcessIdentity $script:Desktop 4321} 'Duplicate discovered identity fails.'
Reset-Mock;Check-ProcessIdentity $script:Desktop 4321;$script:Desktop.Processes[0].CreationTicks++
Require-Throws {Check-ProcessIdentity $script:Desktop 4321} 'Changed expected birth cannot replace the old pin.'
Require ($script:CimCalls -eq 1 -and [ProcessIdentityFixture]::OpenCalls -eq 1 -and [ProcessIdentityFixture]::VerifyCalls -eq 0) 'A changed expected identity never repins or queries a replacement.'
Reset-Mock;Check-ProcessIdentity $script:Desktop 4321;$script:Desktop.ExecutablePath='D:\fixture\changed.exe';$script:Desktop.Processes[0].ExecutablePath=$script:Desktop.ExecutablePath
Require-Throws {Check-ProcessIdentity $script:Desktop 4321} 'Changed expected path cannot replace the old pin.'
Reset-Mock;Check-ProcessIdentity $script:Desktop 4321;[ProcessIdentityFixture]::FailVerify=$true
Require-Throws {Check-ProcessIdentity $script:Desktop 4321} 'Cached fresh native query failure cannot fall back to CIM or a PID cache.'
Require ($script:CimCalls -eq 1 -and [ProcessIdentityFixture]::OpenCalls -eq 1) 'Cached failure never silently reopens the PID.'
foreach($entry in @($script:DesktopProcessPins.Values)){$entry.Pin.Dispose()};$script:DesktopProcessPins.Clear()
Require ([ProcessIdentityFixture]::DisposeCalls -eq 1) 'Final owned pin disposal is exact.'
[Console]::Out.WriteLine($script:Checks)
`;
const isolated = fs.mkdtempSync(path.join(process.env.DOT_JOURNAL_TEST_DIRECTORY || path.join(__dirname,'..','logs'),'process-identity-fixture-'));
let result;
try {
  const command = "$ErrorActionPreference='Stop';\nAdd-Type -TypeDefinition @'\n" + native[1] + '\n' + mocks + "\n'@\n" + checks;
  fs.writeFileSync(path.join(isolated,'check.ps1'),'\uFEFF'+command,'utf8');
  result=spawnSync(path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),
    ['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(isolated,'check.ps1')],
    {encoding:'utf8',windowsHide:true,timeout:30000,env:{...process.env,TEMP:isolated,TMP:isolated,
      PBI_NODE_EXE:process.execPath,PBI_SOURCE_FILE:path.join(__dirname,'codex-desktop-ui.ps1')}});
} finally {
  fs.unlinkSync(path.join(isolated,'check.ps1'));
}
assert.equal(result.status,0,result.stderr||result.error?.message||'Held process fixture failed.');
assert.equal(Number(result.stdout.trim()),48);
// Existing UI/input boundaries must remain direct callers of the identity
// gate; the optimization changes the gate implementation, never its callers.
assert.match(source,/function Check-BoundForeground \{\s+Check-ProcessIdentity \$script:Desktop \$script:BoundProcess/);
assert.match(source,/function Check-ComposerFocus\([\s\S]*?Check-ProcessIdentity \$script:Desktop \$focused\.Current\.ProcessId/);
assert.match(source,/foreach \(\$entry in @\(\$script:DesktopProcessPins\.Values\)\)[\s\S]*?\$entry\.Pin\.Dispose\(\)/);
console.log('PASS 48 real owned-process and isolated bootstrap/cache identity checks; existing native boundaries retained.');
