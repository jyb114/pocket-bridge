'use strict';
// Run selected tray functions against synthetic HTTP/CIM/held-process objects.
// The tray UI, real network, real process lookup and real kills never execute.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const tray = fs.readFileSync(path.join(root, 'desktop/tray.ps1'), 'utf8');
assert(!/Stop-Process|\*mobile-proxy\*|\*\$Base\*/.test(tray), 'Tray must not terminate broad process matches');
assert(/Get-BridgeNowMilliseconds\) \+ 95000/.test(tray), 'Controlled stop waits 90 seconds plus grace');
assert(/\$miStart\.Enabled = \(-not \$has -and -not \$script:StopInProgress -and -not \(Test-BridgeShutdownPending\)\)/.test(tray));
assert(/\$miStop\.Enabled = \(\$has -and -not \$script:StopInProgress\)/.test(tray));
assert(/\$stopped = Stop-Gateway\s+if \(-not \$stopped\.ok\) \{[\s\S]*?return\s+\}[\s\S]*?\$out = & \$NodeExe \$RotateJs/.test(tray),
  'Access-key rotation must stop on unconfirmed gateway shutdown');
assert(/\$stopped = Stop-Gateway\s+if \(-not \$stopped\.ok\) \{[\s\S]*?return\s+\}[\s\S]*?\$notify\.Visible = \$false/.test(tray),
  'Full quit must not claim closure when controlled stop is unconfirmed');
if (process.platform !== 'win32') {
  console.log('SKIP tray PowerShell execution: Windows required; static boundaries passed.');
  process.exit(0);
}
const tempBase = path.resolve(os.tmpdir());
const scratch = fs.mkdtempSync(path.join(tempBase, 'pb-tray-stop-'));
const fixturePath = path.join(scratch, 'fixture.ps1');
const fixture = String.raw`param([string]$SourcePath, [string]$FixtureBase)
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($SourcePath, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Tray source does not parse' }
$names = @('Test-BridgeUuid','Get-BridgeInstanceId','Get-BridgeCanonicalPath','Test-BridgePathEqual',
  'Split-BridgeProcessArguments','Get-BridgeProcessInfo','Get-BridgeBirthMilliseconds','Get-BridgeGatewayProof',
  'Get-BridgeHealth','Find-Gateway','Start-Gateway','Get-BridgeTunnelProofs','Test-BridgeSameProcess',
  'Stop-BridgeOwnedTunnel','Get-BridgeNowMilliseconds','Write-BridgeStopFlag','Set-BridgeStopControls',
  'Pump-BridgeStopEvents','Test-BridgeDaemonOperationPending','Test-BridgeGatewayStartupPending',
  'Test-BridgeShutdownPending','Assert-BridgeOwnedStopPaths','Test-BridgeInstalledTunnelPending',
  'Test-BridgeAlreadyStoppedFences','Get-BridgeAlreadyStoppedResult','Stop-Gateway')
$functions = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -in $names }, $false))
if ($functions.Count -ne $names.Count) { throw 'Required functions not found' }
foreach ($function in $functions) { . ([scriptblock]::Create($function.Extent.Text)) }
$Base = $FixtureBase; $LogDir = Join-Path $Base 'logs'
$NodeExe = Join-Path $Base 'runtime\node.exe'; $ProxyJs = Join-Path $Base 'scripts\mobile-proxy.js'
$StopFlag = Join-Path $LogDir 'user-stopped.flag'; $TunnelExe = Join-Path $Base 'cloudflared\cloudflared.exe'
$LeasePath = Join-Path $LogDir 'daemon-operation.lock'
$Instance = '11111111-1111-4111-8111-111111111111'; $Boot = '22222222-2222-4222-8222-222222222222'
$Birth = [datetime]'2026-10-01T01:02:03.456Z'
[void][IO.Directory]::CreateDirectory($LogDir)
$script:passes = 0
function Check($Label, [scriptblock]$Body) { & $Body; $script:passes++; Write-Output ('OK ' + $Label) }
function Assert($Value, $Message) { if (-not $Value) { throw $Message } }
function Clone($Value) { return ($Value | ConvertTo-Json -Compress | ConvertFrom-Json) }
function Reset {
  if (Test-Path -LiteralPath $StopFlag) { Remove-Item -LiteralPath $StopFlag -Force }
  if (Test-Path -LiteralPath $LeasePath) { Remove-Item -LiteralPath $LeasePath -Force }
  $config = Join-Path $LogDir 'cloudflared-named.yml'
  if (Test-Path -LiteralPath $config) { Remove-Item -LiteralPath $config }
  [IO.File]::WriteAllText((Join-Path $LogDir 'instance.json'), ('{"instanceId":"' + $Instance + '"}'))
  [IO.File]::WriteAllText((Join-Path $LogDir 'gateway-port.txt'), '8081')
  $script:ownHealth = [pscustomobject]@{ service='pocket-bridge-gateway'; instanceId=$Instance; bootId=$Boot; pid=101; port=8081 }
  $script:ownProcess = [pscustomobject]@{ ProcessId=101; Name='node.exe'; ExecutablePath=$NodeExe;
    CommandLine=('"' + $NodeExe + '" "' + $ProxyJs + '"'); CreationDate=$Birth }
  $script:ownTunnel = [pscustomobject]@{ ProcessId=301; Name='cloudflared.exe'; ExecutablePath=$TunnelExe;
    CommandLine=('"' + $TunnelExe + '" tunnel --url http://127.0.0.1:8081 --no-autoupdate'); CreationDate=$Birth }
  $script:tunnelList = @($script:ownTunnel)
  $script:posted=$false; $script:mode='exit'; $script:responseMode='accepted'; $script:preChange=$false
  $script:ownHealthReads=0; $script:afterHealthReads=0; $script:clock=0
  $script:killed=@(); $script:events=@(); $script:pumped=0; $script:requestCount=0
  $script:StopInProgress=$false; $script:startDuringPump=$false; $script:duplicateResult=$null
  $script:PendingGatewayStopProof=$null; $script:PendingGatewayStopHandle=$null
  $script:fakeStartCount=0; $script:tunnelHandleMode='same'; $script:waitResult=$true
  $script:gatewayHandleBirthChanged=$false
  $script:reparsePath=$null; $script:reparseReads=0
  $script:leaseUnreadable=$false; $script:releaseLeaseOnPump=0
  $script:lateTunnel=$null; $script:leaseOnTunnelCapture=$false; $script:leaseOnTunnelKill=$false
  $script:otherGatewayList=@(); $script:gatewayScanUnreadable=$false
  $script:gatewayScans=0; $script:tunnelScans=0
  $script:tunnelScanUnreadable=$false; $script:leaseOnGatewayScan=0
  $script:startupOnTunnelScan=0
  $script:forceHeldGatewayAlive=$false
}
# Override every command that could touch actual HTTP, processes or GUI.
function Get-BridgeHealth([int]$Port) {
  if ($Port -ne 8081) {
    return [pscustomobject]@{ service='pocket-bridge-gateway'; instanceId='33333333-3333-4333-8333-333333333333'; bootId=$Boot; pid=202; port=$Port }
  }
  if (-not $script:posted) {
    $script:ownHealthReads++
    if ($script:preChange -and $script:ownHealthReads -ge 2) { $changed=Clone $script:ownHealth; $changed.bootId='44444444-4444-4444-8444-444444444444'; return $changed }
    return $script:ownHealth
  }
  $script:afterHealthReads++
  if ($script:mode -in @('timeout','health-stale')) { return $script:ownHealth }
  if ($script:mode -eq 'new-boot') { $changed=Clone $script:ownHealth; $changed.bootId='44444444-4444-4444-8444-444444444444'; return $changed }
  throw 'synthetic listener unavailable'
}
function Get-CimInstance { param($ClassName,$Filter,$ErrorAction)
  Assert ($ClassName -eq 'Win32_Process') 'Unexpected native class'
  if ($Filter -eq "Name='cloudflared.exe'") {
    $script:tunnelScans++; $script:events += 'tunnel-proof-recapture'
    if ($script:tunnelScanUnreadable) { throw 'synthetic tunnel enumeration unavailable' }
    if ($script:leaseOnTunnelCapture) { [void][IO.Directory]::CreateDirectory($LeasePath) }
    if ($script:startupOnTunnelScan -gt 0 -and $script:tunnelScans -eq $script:startupOnTunnelScan) {
      $startup=Clone $script:ownProcess; $startup.ProcessId=102
      $script:otherGatewayList=@($startup)
    }
    return $script:tunnelList
  }
  if ($Filter -eq "Name='node.exe'") {
    $script:gatewayScans++
    if ($script:gatewayScanUnreadable) { throw 'synthetic process enumeration unavailable' }
    if ($script:leaseOnGatewayScan -gt 0 -and $script:gatewayScans -eq $script:leaseOnGatewayScan) { [void][IO.Directory]::CreateDirectory($LeasePath) }
    $current = Get-CimInstance Win32_Process -Filter 'ProcessId=101' -ErrorAction Stop
    $found=@($script:otherGatewayList)
    if ($current) { $found=@($current) + $found }
    return $found
  }
  if ($Filter -eq 'ProcessId=101') {
    if (-not $script:posted) { return $script:ownProcess }
    if ($script:mode -in @('timeout','health-gone-alive')) { return $script:ownProcess }
    if ($script:mode -eq 'reused-pid') { $changed=Clone $script:ownProcess; $changed.CreationDate=$Birth.AddDays(1); return $changed }
    if ($script:mode -eq 'temporary' -and $script:afterHealthReads -le 1) { return $script:ownProcess }
    $script:events += 'gateway-physically-gone'; return $null
  }
  if ($Filter -eq 'ProcessId=301') {
    if ($script:tunnelHandleMode -eq 'changed-command') { $changed=Clone $script:ownTunnel; $changed.CommandLine += ' --unknown'; return $changed }
    return $script:ownTunnel
  }
  if ($Filter -eq 'ProcessId=302') { return $script:lateTunnel }
  if ($Filter -match '^ProcessId=([1-9][0-9]*)$') {
    return @($script:otherGatewayList | Where-Object { $_.ProcessId -eq [int]$Matches[1] })
  }
  return $null
}
function Invoke-RestMethod { param($Uri,$Method,$Headers,$ContentType,$Body,$TimeoutSec,$ErrorAction)
  Assert ($Uri -eq 'http://127.0.0.1:8081/__console/action' -and $Method -eq 'Post') 'Unexpected HTTP path'
  Assert ($Headers.Count -eq 1 -and $Headers.Origin -eq 'http://127.0.0.1:8081') 'Exact Origin required'
  $data = [Text.Encoding]::UTF8.GetString($Body) | ConvertFrom-Json
  Assert (@($data.PSObject.Properties).Count -eq 3 -and $data.action -eq 'stop-gateway' -and
    $data.expectedBootId -eq $Boot -and $data.expectedInstanceId -eq $Instance) 'Exact boot/instance body required'
  Assert (Test-Path -LiteralPath $StopFlag -PathType Leaf) 'Stop flag must precede request'
  $script:requestCount++; $script:posted=$true; $script:events += 'controlled-request'
  if ($script:responseMode -eq 'reject') { throw 'synthetic request rejection' }
  $result=[pscustomobject]@{ ok=$true; stopping=$true; shutdownScheduled=$true; bootId=$Boot; instanceId=$Instance; pid=101 }
  if ($script:responseMode -eq 'wrong-boot') { $result.bootId='44444444-4444-4444-8444-444444444444' }
  if ($script:responseMode -eq 'wrong-instance') { $result.instanceId='44444444-4444-4444-8444-444444444444' }
  if ($script:responseMode -eq 'wrong-pid') { $result.pid=999 }
  if ($script:responseMode -eq 'not-scheduled') { $result.shutdownScheduled=$false }
  return $result
}
function Get-Process { param($Id,$ErrorAction)
  if ($Id -eq 101) {
    $script:events += 'held-gateway-handle'
    $start = if ($script:gatewayHandleBirthChanged) { $Birth.AddDays(1) } else { $Birth }
    $fake=[pscustomobject]@{ Id=$Id; Handle=1; StartTime=$start }
    $fake | Add-Member ScriptProperty HasExited {
      if ($script:forceHeldGatewayAlive) { return $false }
      return ($script:posted -and $script:mode -notin @('timeout','health-gone-alive','handle-alive','new-boot','reused-pid') -and
        ($script:mode -ne 'temporary' -or $script:afterHealthReads -gt 1))
    }
    $fake | Add-Member ScriptMethod Dispose { $script:events += 'held-gateway-dispose' }
    return $fake
  }
  Assert ($Id -in @(301,302)) 'Unverified native process lookup'
  $script:events += 'held-tunnel-handle'
  $start = if ($script:tunnelHandleMode -eq 'changed-birth') { $Birth.AddDays(1) } else { $Birth }
  $fake=[pscustomobject]@{ Id=$Id; Handle=1; StartTime=$start }
  $fake | Add-Member ScriptMethod Kill {
    $script:killed += $this.Id; $script:events += 'held-tunnel-kill'
    if ($script:leaseOnTunnelKill) { [void][IO.Directory]::CreateDirectory($LeasePath) }
  }
  $fake | Add-Member ScriptMethod WaitForExit { param($Milliseconds) return $script:waitResult }
  $fake | Add-Member ScriptMethod Dispose { $script:events += 'held-tunnel-dispose' }
  return $fake
}
function Start-Process { $script:fakeStartCount++; throw 'Actual process start prohibited' }
function Get-Item { param($LiteralPath,[switch]$Force,$ErrorAction)
  if ($LiteralPath -eq $LeasePath -and $script:leaseUnreadable) {
    throw [UnauthorizedAccessException]::new('synthetic lease metadata unavailable')
  }
  # .NET Framework expands 8.3 paths such as the Windows runner's RUNNER~1
  # TEMP. Match the same literal directory after normalization, not its raw
  # spelling, or the fake reparse metadata never reaches the source guard.
  if ($script:reparsePath -and [string]::Equals([IO.Path]::GetFullPath($LiteralPath),
      [IO.Path]::GetFullPath($script:reparsePath), [StringComparison]::OrdinalIgnoreCase)) {
    $script:reparseReads++
    return [pscustomobject]@{ PSIsContainer=(Test-Path -LiteralPath $LiteralPath -PathType Container); Attributes=[IO.FileAttributes]::ReparsePoint }
  }
  return Microsoft.PowerShell.Management\Get-Item -LiteralPath $LiteralPath -Force -ErrorAction Stop
}
function Start-Sleep { param($Milliseconds) $script:events += 'bounded-poll-wait' }
function Get-BridgeNowMilliseconds { $script:clock += 1000; return $script:clock }
function Pump-BridgeStopEvents {
  $script:pumped++
  Assert $script:StopInProgress 'UI pump requires admission guard'
  if ($script:startDuringPump) { Start-Gateway; $script:duplicateResult=Stop-Gateway }
  if ($script:releaseLeaseOnPump -gt 0 -and $script:pumped -eq $script:releaseLeaseOnPump) {
    [IO.Directory]::Delete($LeasePath)
    if ($script:lateTunnel) { $script:tunnelList=@($script:lateTunnel) }
    $script:events += 'daemon-lease-released'
  }
}
Check 'strict argv supports quoted spaces and rejects malformed or escaped quotes' {
  $valid=Split-BridgeProcessArguments '"D:\fixture bridge\node.exe" "D:\fixture bridge\scripts\mobile-proxy.js"'
  Assert ($valid.Count -eq 2 -and $valid[1] -eq 'D:\fixture bridge\scripts\mobile-proxy.js') 'Quoted argv mismatch'
  Assert ($null -eq (Split-BridgeProcessArguments '"D:\bad\node.exe')) 'Unclosed quote accepted'
  Assert ($null -eq (Split-BridgeProcessArguments '"D:\bad\"node.exe" script.js')) 'Ambiguous escaped quote accepted'
}
Check 'discovery selects only own instance, executable and script' {
  Reset; $found=Find-Gateway
  Assert ($found.port -eq 8081 -and $found.instanceId -eq $Instance) 'Foreign gateway selected'
  Assert ($script:requestCount -eq 0 -and $script:killed.Count -eq 0) 'Discovery mutated processes'
}
Check 'script prefixes, extra arguments, executable changes and missing birth are refused' {
  foreach ($kind in @('script-prefix','argument','executable','birth')) {
    Reset
    if ($kind -eq 'script-prefix') { $script:ownProcess.CommandLine=('"' + $NodeExe + '" "' + $ProxyJs + '.other"') }
    if ($kind -eq 'argument') { $script:ownProcess.CommandLine += ' "' + $ProxyJs + '"' }
    if ($kind -eq 'executable') { $script:ownProcess.ExecutablePath=$NodeExe + '.other' }
    if ($kind -eq 'birth') { $script:ownProcess.CreationDate=$null }
    Assert ($null -eq (Get-BridgeGatewayProof $script:ownHealth $Instance -RequireBoot)) 'Invalid gateway proof accepted'
  }
}
Check 'old health without boot cannot stop and has no force fallback' {
  Reset; $script:ownHealth.PSObject.Properties.Remove('bootId'); $result=Stop-Gateway
  Assert ($result.code -eq 'identity-unverified' -and $script:requestCount -eq 0) 'Old gateway stopped'
  Assert (-not (Test-Path -LiteralPath $StopFlag) -and $script:killed.Count -eq 0) 'Unverified stop changed state'
}
Check 'missing PID cannot stop any gateway' {
  Reset; $script:ownHealth.PSObject.Properties.Remove('pid'); $result=Stop-Gateway
  Assert (-not $result.ok -and $script:requestCount -eq 0 -and $script:killed.Count -eq 0) 'Missing PID accepted'
}
Check 'accepted scheduling waits physical gateway exit before held tunnel kill' {
  Reset; $result=Stop-Gateway
  Assert ($result.ok -and $result.gatewayStopped -and $result.tunnelsStopped -eq 1) 'Controlled stop failed'
  Assert ($script:events.IndexOf('gateway-physically-gone') -lt $script:events.IndexOf('held-tunnel-kill')) 'Early tunnel kill'
  Assert ($script:events.IndexOf('held-tunnel-handle') -lt $script:events.IndexOf('held-tunnel-kill')) 'PID kill without handle'
  Assert ($script:events.IndexOf('held-gateway-handle') -lt $script:events.IndexOf('controlled-request')) 'Gateway lifetime was not pinned before request'
}
Check 'scheduled-but-alive remains pending for bounded wait without forced stop' {
  Reset; $script:mode='timeout'; $result=Stop-Gateway
  Assert ($result.code -eq 'shutdown-pending' -and $script:killed.Count -eq 0) 'Scheduling counted as completion'
  Assert ($script:clock -ge 95000 -and $script:pumped -gt 0 -and (Test-Path -LiteralPath $StopFlag)) 'Missing bounded wait/flag/pump'
}
Check 'HTTP disappearance does not establish physical gateway exit' {
  Reset; $script:mode='health-gone-alive'; $result=Stop-Gateway
  Assert ($result.code -eq 'shutdown-pending' -and $script:killed.Count -eq 0) 'HTTP failure killed tunnel'
}
Check 'temporary health failure can recover to confirmed process exit' {
  Reset; $script:mode='temporary'; $result=Stop-Gateway
  Assert ($result.ok -and $script:pumped -ge 1) 'Transient health failure aborted safe drain'
}
Check 'request rejection retains flag and leaves processes alone' {
  Reset; $script:responseMode='reject'; $result=Stop-Gateway
  Assert (-not $result.ok -and $script:killed.Count -eq 0 -and (Test-Path -LiteralPath $StopFlag)) 'Rejected request changed state'
}
Check 'response binds exact boot, instance, PID and scheduling capability' {
  foreach ($kind in @('wrong-boot','wrong-instance','wrong-pid','not-scheduled')) {
    Reset; $script:responseMode=$kind; $result=Stop-Gateway
    Assert ($result.code -eq 'shutdown-unconfirmed' -and $script:killed.Count -eq 0) 'Unbound scheduling response accepted'
  }
}
Check 'pre-request changed boot aborts before flag or request' {
  Reset; $script:preChange=$true; $result=Stop-Gateway
  Assert ($result.code -eq 'gateway-replaced' -and $script:requestCount -eq 0 -and -not (Test-Path -LiteralPath $StopFlag)) 'Changed boot stopped'
}
Check 'new gateway boot during drain leaves tunnels untouched' {
  Reset; $script:mode='new-boot'; $result=Stop-Gateway
  Assert ($result.code -eq 'gateway-replaced' -and $script:killed.Count -eq 0) 'Replacement affected'
}
Check 'reused gateway PID cannot count as original process exit' {
  Reset; $script:mode='reused-pid'; $result=Stop-Gateway
  Assert ($result.code -eq 'process-replaced' -and $script:killed.Count -eq 0) 'Reused gateway PID accepted'
}
Check 'tunnel proof requires exact executable, argv and gateway origin' {
  Reset; $wrongRoot=Clone $script:ownTunnel; $wrongRoot.ExecutablePath=$TunnelExe + '.other'
  $wrongPort=Clone $script:ownTunnel; $wrongPort.CommandLine=$wrongPort.CommandLine.Replace(':8081',':8082')
  $wrongArg=Clone $script:ownTunnel; $wrongArg.CommandLine += ' --unknown'
  $script:tunnelList=@($script:ownTunnel,$wrongRoot,$wrongPort,$wrongArg)
  $found=Get-BridgeTunnelProofs 8081
  Assert ($found.proofs.Count -eq 1 -and $found.proofs[0].processId -eq 301 -and $found.unverified -eq 2) 'Foreign tunnel owned'
}
Check 'named tunnel uses only own config and its exact gateway origin' {
  Reset; $config=Join-Path $LogDir 'cloudflared-named.yml'
  [IO.File]::WriteAllText($config, "tunnel: disposable-name
ingress:
  - hostname: example.invalid
    service: http://127.0.0.1:8081
  - service: http_status:404
")
  $script:ownTunnel.CommandLine=('"' + $TunnelExe + '" tunnel --config "' + $config + '" run disposable-name --no-autoupdate')
  Assert ((Get-BridgeTunnelProofs 8081).proofs.Count -eq 1) 'Exact named tunnel rejected'
  Assert ((Get-BridgeTunnelProofs 8082).proofs.Count -eq 0) 'Wrong named origin accepted'
  $script:ownTunnel.CommandLine=$script:ownTunnel.CommandLine.Replace($config,$config + '.other')
  Assert ((Get-BridgeTunnelProofs 8081).proofs.Count -eq 0) 'Config substring accepted'
}
Check 'tunnel birth change refuses held-handle kill' {
  Reset; $script:tunnelHandleMode='changed-birth'; $result=Stop-Gateway
  Assert ($result.gatewayStopped -and $result.code -eq 'tunnel-unconfirmed' -and $script:killed.Count -eq 0) 'Reused tunnel PID killed'
}
Check 'tunnel identity is rechecked after handle acquisition' {
  Reset; $script:tunnelHandleMode='changed-command'; $result=Stop-Gateway
  Assert ($result.code -eq 'tunnel-unconfirmed' -and $script:killed.Count -eq 0) 'Changed tunnel command killed'
}
Check 'unconfirmed tunnel termination is not counted as success' {
  Reset; $script:waitResult=$false; $result=Stop-Gateway
  Assert (-not $result.ok -and $result.code -eq 'tunnel-unconfirmed' -and $result.tunnelsStopped -eq 0) 'Failed exit counted'
}
Check 'existing regular watchdog stop flag is preserved' {
  Reset; [IO.File]::WriteAllText($StopFlag,'existing stop intent'); $result=Stop-Gateway
  Assert ($result.ok -and [IO.File]::ReadAllText($StopFlag) -eq 'existing stop intent') 'Flag overwritten'
}
Check 'nonregular stop flag prevents shutdown request' {
  Reset; New-Item -ItemType Directory -Path $StopFlag | Out-Null; $result=Stop-Gateway
  Assert (-not $result.ok -and $script:requestCount -eq 0 -and $script:killed.Count -eq 0) 'Invalid flag accepted'
  Remove-Item -LiteralPath $StopFlag
}
Check 'missing own instance identity cannot select another installation' {
  Reset; Remove-Item -LiteralPath (Join-Path $LogDir 'instance.json'); $result=Stop-Gateway
  Assert ($result.code -eq 'identity-unverified' -and $script:requestCount -eq 0) 'Foreign stop without identity'
}
Check 'responsive pump cannot start or duplicate Stop while shutdown drains' {
  Reset; $script:mode='timeout'; $script:startDuringPump=$true; $result=Stop-Gateway
  Assert ($result.code -eq 'shutdown-pending' -and $script:pumped -gt 0 -and $script:fakeStartCount -eq 0) 'Pump started process'
  Assert ($script:duplicateResult.code -eq 'shutdown-pending' -and $script:requestCount -eq 1) 'Duplicate stop escaped'
  Assert ((Test-Path -LiteralPath $StopFlag) -and -not $script:StopInProgress) 'Guard or flag not retained'
}
Check 'Start cannot clear stop intent after timeout while the exact gateway remains alive' {
  Reset; $script:mode='timeout'; $result=Stop-Gateway; Start-Gateway
  Assert ($result.code -eq 'shutdown-pending' -and $script:fakeStartCount -eq 0) 'Post-timeout Start raced original gateway'
  Assert ((Test-Path -LiteralPath $StopFlag) -and $script:PendingGatewayStopProof) 'Pending stop intent was lost'
}
Check 'pending stop latch clears only after physical original process exit' {
  Reset; $script:mode='timeout'; $null=Stop-Gateway
  Assert (Test-BridgeShutdownPending) 'Live gateway was not held pending'
  $script:mode='exit'
  Assert (-not (Test-BridgeShutdownPending) -and -not $script:PendingGatewayStopProof) 'Physical exit did not clear stale latch'
}
Check 'CIM row disappearance cannot override a still-live held gateway handle' {
  Reset; $script:mode='handle-alive'; $result=Stop-Gateway
  Assert ($result.code -eq 'shutdown-pending' -and $script:killed.Count -eq 0) 'CIM absence was mistaken for actual handle exit'
}
Check 'gateway handle birth mismatch aborts before writing flag or requesting shutdown' {
  Reset; $script:gatewayHandleBirthChanged=$true; $result=Stop-Gateway
  Assert ($result.code -eq 'gateway-replaced' -and $script:requestCount -eq 0 -and -not (Test-Path -LiteralPath $StopFlag)) 'Reused gateway handle accepted'
}
Check 'stop flag is confined to this installation owned literal log path' {
  Reset; $original=$StopFlag; $StopFlag=Join-Path $Base 'outside-stop.flag'
  try {
    $result=Stop-Gateway
    Assert (-not $result.ok -and $script:requestCount -eq 0 -and -not (Test-Path -LiteralPath $StopFlag)) 'Flag path escaped owned logs'
  } finally { $StopFlag=$original }
}
foreach ($location in @('base','logs','instance')) {
  Check ('reparse-point ' + $location + ' refuses shutdown and flag mutation') {
    Reset
    $script:reparsePath = if ($location -eq 'base') { $Base } elseif ($location -eq 'logs') { $LogDir } else { Join-Path $LogDir 'instance.json' }
    $result=Stop-Gateway
    Assert (-not $result.ok -and $script:requestCount -eq 0 -and -not (Test-Path -LiteralPath $StopFlag)) 'Reparse path was used for stop'
    Assert ($script:reparseReads -gt 0) 'Synthetic reparse metadata was not exercised'
  }
}
Check 'orphan daemon lease prevents completion even when the gateway has physically exited' {
  Reset; [void][IO.Directory]::CreateDirectory($LeasePath); $result=Stop-Gateway
  Assert ($result.code -eq 'shutdown-pending' -and $script:killed.Count -eq 0) 'Orphan lease was reclaimed'
  Assert ((Test-Path -LiteralPath $LeasePath) -and (Test-Path -LiteralPath $StopFlag) -and $script:tunnelScans -eq 0) 'Pending lease changed intent or tunnels'
}
Check 'unreadable daemon lease is pending and cannot permit tunnel termination' {
  Reset; $script:leaseUnreadable=$true; $result=Stop-Gateway
  Assert ($result.code -eq 'shutdown-pending' -and $script:killed.Count -eq 0 -and $script:tunnelScans -eq 0) 'Unreadable lease counted as absent'
}
Check 'Start cannot clear stop intent for a present lease without a gateway proof' {
  Reset; [IO.File]::WriteAllText($StopFlag,'preserve stop intent')
  [void][IO.Directory]::CreateDirectory($LeasePath); Start-Gateway
  Assert ($script:fakeStartCount -eq 0 -and [IO.File]::ReadAllText($StopFlag) -eq 'preserve stop intent') 'Start erased intent for orphan lease'
}
Check 'Start cannot clear stop intent for an unreadable lease after the original gateway exits' {
  Reset; $script:mode='timeout'; $null=Stop-Gateway; $script:mode='exit'; $script:leaseUnreadable=$true
  Start-Gateway
  Assert ($script:fakeStartCount -eq 0 -and (Test-Path -LiteralPath $StopFlag)) 'Start raced unreadable admitted operation'
}
Check 'lease release admits only fresh exact tunnel proofs created during drain' {
  Reset; [void][IO.Directory]::CreateDirectory($LeasePath); $script:releaseLeaseOnPump=2
  $script:lateTunnel=Clone $script:ownTunnel; $script:lateTunnel.ProcessId=302
  $result=Stop-Gateway
  Assert ($result.ok -and $result.tunnelsStopped -eq 1 -and $script:killed.Count -eq 1 -and $script:killed[0] -eq 302) 'Admitted late tunnel was missed or stale tunnel killed'
  Assert ($script:events.IndexOf('daemon-lease-released') -lt $script:events.IndexOf('tunnel-proof-recapture')) 'Tunnel capture preceded daemon quiescence'
}
Check 'lease appearing during tunnel recapture prevents termination' {
  Reset; $script:leaseOnTunnelCapture=$true; $result=Stop-Gateway
  Assert ($result.code -eq 'shutdown-pending' -and $script:killed.Count -eq 0) 'Lease recapture race affected tunnel'
}
Check 'lease appearing before final result prevents a completed stop claim' {
  Reset; $script:leaseOnTunnelKill=$true; $result=Stop-Gateway
  Assert (-not $result.ok -and $result.code -eq 'shutdown-pending' -and $result.tunnelsStopped -eq 1) 'Final lease race counted as complete'
}
Check 'another exact owned gateway startup without health prevents completion and later Start' {
  Reset; $startup=Clone $script:ownProcess; $startup.ProcessId=102; $startup.CreationDate=$Birth.AddSeconds(1)
  $script:otherGatewayList=@($startup); $result=Stop-Gateway; Start-Gateway
  Assert ($result.code -eq 'shutdown-pending' -and $script:killed.Count -eq 0 -and $script:fakeStartCount -eq 0) 'Unhealthy owned startup was ignored'
  Assert ((Test-Path -LiteralPath $StopFlag) -and $script:tunnelScans -eq 0) 'Startup refusal lost stop intent'
}
Check 'exact owned startup with unreadable birth remains pending without termination authority' {
  Reset; $startup=Clone $script:ownProcess; $startup.ProcessId=102; $startup.CreationDate=$null
  $script:otherGatewayList=@($startup); $result=Stop-Gateway
  Assert ($result.code -eq 'shutdown-pending' -and $script:killed.Count -eq 0) 'Unknown startup birth falsely proved absence'
}
Check 'unreadable gateway startup enumeration prevents completion' {
  Reset; $script:gatewayScanUnreadable=$true; $result=Stop-Gateway
  Assert ($result.code -eq 'shutdown-pending' -and $script:killed.Count -eq 0) 'Enumeration failure counted as absence'
}
Check 'other installation and non-gateway node argv do not become owned startups' {
  Reset; $foreign=Clone $script:ownProcess; $foreign.ProcessId=202
  $foreign.ExecutablePath=$NodeExe + '.other'; $foreign.CommandLine=('"'+$foreign.ExecutablePath+'" "'+$ProxyJs+'"')
  $prefix=Clone $script:ownProcess; $prefix.ProcessId=203; $prefix.CommandLine=('"'+$NodeExe+'" "'+$ProxyJs+'.other"')
  $extra=Clone $script:ownProcess; $extra.ProcessId=204; $extra.CommandLine += ' --unknown'
  $script:otherGatewayList=@($foreign,$prefix,$extra); $result=Stop-Gateway
  Assert ($result.ok -and $script:killed.Count -eq 1 -and $script:killed[0] -eq 301) 'Foreign or noncanonical startup became owned'
}
Check 'timer and mouse callbacks return before refresh or console work while Stop drains' {
  Reset; $script:StopInProgress=$true
  foreach ($member in @('add_Tick','add_MouseClick')) {
    $callbackNode=@($ast.FindAll({ param($node) $node -is [Management.Automation.Language.InvokeMemberExpressionAst] -and $node.Member.Value -eq $member },$true))
    Assert ($callbackNode.Count -eq 1) 'Tray callback missing or ambiguous'
    & $callbackNode[0].Arguments[0].ScriptBlock.GetScriptBlock()
  }
  Assert ($script:ownHealthReads -eq 0 -and $script:fakeStartCount -eq 0) 'Pump callback performed refresh or spawn'
}
Check 'console and picker callbacks cannot refresh or enqueue desktop work during Stop' {
  Reset; $script:StopInProgress=$true
  foreach ($name in @('miConsole','miPicker')) {
    $assignment=@($ast.FindAll({ param($node) $node -is [Management.Automation.Language.AssignmentStatementAst] -and
      $node.Left -is [Management.Automation.Language.VariableExpressionAst] -and $node.Left.VariablePath.UserPath -eq $name },$true))
    Assert ($assignment.Count -eq 1) 'Menu callback missing or ambiguous'
    & $assignment[0].Right.PipelineElements[0].CommandElements[2].ScriptBlock.GetScriptBlock()
  }
  Assert ($script:ownHealthReads -eq 0 -and $script:fakeStartCount -eq 0) 'Console callback escaped stop guard'
}
Check 'Stop controls temporarily disable and restore console and picker admissions' {
  Reset; $miConsole=[pscustomobject]@{Enabled=$true}; $miPicker=[pscustomobject]@{Enabled=$false}
  Set-BridgeStopControls $true
  Assert (-not $miConsole.Enabled -and -not $miPicker.Enabled) 'Console admission remained enabled'
  Set-BridgeStopControls $false
  Assert ($miConsole.Enabled -and -not $miPicker.Enabled) 'Console state was not restored'
}
Check 'verified idle no-op supports Stop followed by Full Quit without a second stop request' {
  Reset; $first=Stop-Gateway; $script:tunnelList=@(); $second=Stop-Gateway
  Assert ($first.ok -and $second.ok -and $second.alreadyStopped -and $second.tunnelsStopped -eq 0) 'Already-stopped no-op refused'
  Assert ($script:requestCount -eq 1 -and $script:killed.Count -eq 1 -and (Test-Path -LiteralPath $StopFlag)) 'Idle no-op mutated process state'
}
Check 'verified idle no-op writes stop intent and preserves an existing regular marker' {
  Reset; $script:posted=$true; $script:tunnelList=@(); $result=Stop-Gateway
  Assert ($result.ok -and $result.alreadyStopped -and (Test-Path -LiteralPath $StopFlag)) 'Idle intent not written'
  [IO.File]::WriteAllText($StopFlag,'preserve idle intent'); $result=Stop-Gateway
  Assert ($result.ok -and [IO.File]::ReadAllText($StopFlag) -eq 'preserve idle intent' -and $script:requestCount -eq 0) 'Idle marker overwritten'
}
Check 'idle no-op refuses own or unclassifiable installed tunnels without killing them' {
  foreach ($kind in @('own','own-unknown-argv','unknown-executable','scan-failed')) {
    Reset; $script:posted=$true
    if ($kind -eq 'own-unknown-argv') { $script:ownTunnel.CommandLine += ' --unknown' }
    if ($kind -eq 'unknown-executable') { $script:ownTunnel.ExecutablePath=$null }
    if ($kind -eq 'scan-failed') { $script:tunnelScanUnreadable=$true }
    $result=Stop-Gateway
    Assert (-not $result.ok -and -not $result.alreadyStopped -and $script:killed.Count -eq 0) 'Unknown idle tunnel counted as stopped'
    Assert (-not (Test-Path -LiteralPath $StopFlag)) 'Idle refusal prematurely wrote stop intent'
  }
}
Check 'idle no-op ignores proved foreign tunnel executables' {
  Reset; $script:posted=$true; $script:ownTunnel.ExecutablePath=$TunnelExe + '.foreign'; $result=Stop-Gateway
  Assert ($result.ok -and $result.alreadyStopped -and $script:killed.Count -eq 0) 'Foreign tunnel blocked or was terminated'
}
Check 'idle no-op refuses missing or reparse installation identity before intent writes' {
  foreach ($kind in @('missing-instance','base','logs','instance')) {
    Reset; $script:posted=$true; $script:tunnelList=@()
    if ($kind -eq 'missing-instance') { Remove-Item -LiteralPath (Join-Path $LogDir 'instance.json') }
    if ($kind -eq 'base') { $script:reparsePath=$Base }
    if ($kind -eq 'logs') { $script:reparsePath=$LogDir }
    if ($kind -eq 'instance') { $script:reparsePath=Join-Path $LogDir 'instance.json' }
    $result=Stop-Gateway
    Assert (-not $result.ok -and -not (Test-Path -LiteralPath $StopFlag)) 'Idle no-op accepted unowned metadata'
  }
}
Check 'idle no-op repeats fences after stop intent and refuses an admitted startup' {
  Reset; $script:posted=$true; $script:tunnelList=@(); $script:startupOnTunnelScan=1
  $result=Stop-Gateway
  Assert (-not $result.ok -and -not $result.alreadyStopped -and (Test-Path -LiteralPath $StopFlag)) 'Idle race counted as complete'
  Assert ($script:killed.Count -eq 0 -and $script:requestCount -eq 0) 'Startup race was force stopped'
}
Check 'idle no-op detects lease admission during the repeated post-marker scan' {
  Reset; $script:posted=$true; $script:tunnelList=@(); $script:leaseOnGatewayScan=2
  $result=Stop-Gateway
  Assert (-not $result.ok -and (Test-Path -LiteralPath $StopFlag) -and (Test-Path -LiteralPath $LeasePath)) 'Repeated lease fence missed new admission'
}
Check 'idle no-op refuses any present or unreadable daemon lease' {
  foreach ($kind in @('present','unreadable')) {
    Reset; $script:posted=$true; $script:tunnelList=@()
    if ($kind -eq 'present') { [void][IO.Directory]::CreateDirectory($LeasePath) } else { $script:leaseUnreadable=$true }
    $result=Stop-Gateway
    Assert (-not $result.ok -and -not (Test-Path -LiteralPath $StopFlag)) 'Pending daemon admitted idle completion'
  }
}
Check 'timed-out original handle prevents idle completion and Start despite missing CIM rows' {
  Reset; $script:mode='handle-alive'; $first=Stop-Gateway
  Assert ($script:PendingGatewayStopHandle -and $script:events -notcontains 'held-gateway-dispose') 'Pending actual process handle was released'
  $script:tunnelList=@(); $second=Stop-Gateway; Start-Gateway
  Assert ($first.code -eq 'shutdown-pending' -and -not $second.ok -and $script:fakeStartCount -eq 0) 'Live held original was mistaken for idle'
  Assert ((Test-Path -LiteralPath $StopFlag) -and $script:PendingGatewayStopHandle) 'Pending handle or stop intent was lost'
}
Check 'pending held original releases only after its actual HasExited state' {
  Reset; $script:mode='handle-alive'; $null=Stop-Gateway
  Assert (Test-BridgeShutdownPending) 'Live held original did not remain pending'
  $script:mode='exit'; $script:tunnelList=@()
  Assert (-not (Test-BridgeShutdownPending) -and -not $script:PendingGatewayStopHandle) 'Exited held original did not release'
  Assert ($script:events -contains 'held-gateway-dispose') 'Exited held handle leaked'
}
Check 'a different healthy gateway cannot replace a still-live pending original handle' {
  Reset; $script:mode='handle-alive'; $null=Stop-Gateway
  $script:forceHeldGatewayAlive=$true; $script:mode='health-stale'
  $script:ownHealth.pid=102
  $startup=Clone $script:ownProcess; $startup.ProcessId=102; $startup.CreationDate=$Birth.AddSeconds(1)
  $script:otherGatewayList=@($startup); $result=Stop-Gateway
  Assert ($result.code -eq 'shutdown-pending' -and $script:requestCount -eq 1 -and $script:killed.Count -eq 0) 'New health displaced a held live original'
  Assert ($script:PendingGatewayStopHandle -and $script:PendingGatewayStopProof.processId -eq 101 -and
    $script:events -notcontains 'held-gateway-dispose') 'Original physical lifetime proof was lost'
}
Write-Output ('Passed ' + $script:passes + ' isolated tray lifecycle cases; no UI, HTTP, real process lookup or real process termination executed.')
`;
try {
  fs.writeFileSync(fixturePath, '\uFEFF' + fixture, 'utf8');
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const fixtureBase = path.join(scratch,'fixture bridge [literal]');
  // The second spelling denotes the same owned directory but canonicalizes
  // differently, reproducing short-name TEMP handling without touching C:.
  for (const base of [fixtureBase, fixtureBase + path.sep + '.']) {
    const output = execFileSync(powershell, ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fixturePath,
      '-SourcePath',path.join(root,'desktop/tray.ps1'),'-FixtureBase',base],
    { encoding:'utf8', windowsHide:true, timeout:30000, maxBuffer:1024*1024 });
    process.stdout.write(output);
  }
} finally {
  const resolved = path.resolve(scratch);
  assert(resolved.startsWith(tempBase + path.sep) && path.basename(resolved).startsWith('pb-tray-stop-'));
  fs.rmSync(resolved, {recursive:true, force:true});
}
