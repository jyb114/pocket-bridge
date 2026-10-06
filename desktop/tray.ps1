# DSH 移动端网关 — 桌面客户端
#
# 为什么用 PowerShell + WinForms 而不是 Electron：
#   这个项目从头到尾的前提是「不装任何东西」。Electron 要拖进来一百多兆的运行时，
#   而这个脚本用的 System.Windows.Forms 是 Windows 自带的。启动快、体积为零、
#   二进制包可直接用自带 Node；源码安装则使用系统 PATH 中的 Node。
#
# 它做什么：
#   - 托盘常驻，图标颜色就是服务状态（绿=正常 黄=部分可用 红=没跑 灰=未知）
#   - 一键打开控制台（无边框应用窗口，看着像个原生程序）
#   - 起停服务、复制各条入口地址、复制配对码、轮换密钥、开机自启开关
#
# 注意：本文件必须存成「UTF-8 带 BOM」。Windows PowerShell 5.1 对无 BOM 的文件
# 会按系统 ANSI 码页解码，中文会变成乱码。desktop\make-ps1.js 负责这件事。

param(
  # 自检模式：把「界面能建起来、图标能加载、状态能读到」这几件事验一遍就退出。
  # 有它才好在没人盯屏幕的情况下确认客户端没坏 —— 否则 GUI 程序就只能靠手工点了。
  [switch]$SelfTest,

  # 启动之后**直接把控制台窗口打开**。
  #
  # 桌面快捷方式会带上它。
  #
  # 为什么需要：原来双击桌面图标只会在右下角多一个小图标，什么都没弹出来 ——
  # 双击桌面图标应直接显示主窗口；仅出现托盘图标会让启动状态不明显。
  # 小图标在右下角那一堆里，找不找得到全靠运气。
  #
  # 开机自启那条路**不带**这个开关：开机时不该自己弹窗口。
  [switch]$OpenConsole
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# ── 路径 ──────────────────────────────────────────────────────────────────────
$DesktopDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Base       = Split-Path -Parent $DesktopDir
$NodeExe    = Join-Path $Base 'runtime\node-v24.18.1-win-x64\node.exe'
$ProxyJs    = Join-Path $Base 'scripts\mobile-proxy.js'
$DaemonJs   = Join-Path $Base 'scripts\gateway-daemon.js'
$RotateJs   = Join-Path $Base 'scripts\rotate-key.js'
$OpenAppJs  = Join-Path $DesktopDir 'open-console-app.js'
$LogDir     = Join-Path $Base 'logs'
$IconDir    = Join-Path $DesktopDir 'icons'

if (-not (Test-Path $NodeExe)) {
  # 允许 runtime 目录换版本：找一个能用的
  $found = Get-ChildItem (Join-Path $Base 'runtime') -Recurse -Filter 'node.exe' -ErrorAction SilentlyContinue |
           Select-Object -First 1
  if ($found) { $NodeExe = $found.FullName }
  else {
    # GitHub 源码包不带 runtime；和 build.js 一样回退到系统安装的 Node。
    $systemNode = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($systemNode) { $NodeExe = $systemNode.Source }
  }
}

# ── 单实例 ────────────────────────────────────────────────────────────────────
# 自检模式不占坑，否则「客户端开着的时候跑自检」会直接被劝退
#
# ★ 这里**只抢坑，不做处理**。
#
#   原来抢不到坑就当场弹一个 MessageBox：「客户端已经在运行了（看右下角托盘）」。
#   问题是快捷方式带的是 -WindowStyle Hidden —— **那个对话框是隐形的**，
#   于是第二个实例就永远卡在一个没人看得见的模态框上：
#   进程在、图标没多、界面上什么都没发生，双击图标像是没反应。
#   实测就是这样：两个 powershell 进程，其中一个永远停在脚本开头。
#
#   现在把「已经有一个在跑」这件事的处理挪到下面 ——
#   那里函数都定义好了，可以直接**把控制台窗口叫出来**再退场。
#   对使用者来说，双击一个已经开着的程序、然后把它的窗口带到前面，
#   正是他期待的；弹个「已经在运行了」反而莫名其妙。
$mutex = New-Object System.Threading.Mutex($false, 'Global\DshMobileGatewayTray')
$gotMutex = $false
if (-not $SelfTest) {
  try { $gotMutex = $mutex.WaitOne(0, $false) } catch { $gotMutex = $false }
}

# ── 状态探测 ──────────────────────────────────────────────────────────────────

function Test-BridgeUuid($Value) {
  return ($Value -is [string] -and $Value -match '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
}

function Get-BridgeInstanceId {
  try {
    $file = Join-Path $LogDir 'instance.json'
    $item = Get-Item -LiteralPath $file -Force -ErrorAction Stop
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return $null }
    $record = Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
    if (Test-BridgeUuid $record.instanceId) { return [string]$record.instanceId }
  } catch { }
  return $null
}

function Get-BridgeCanonicalPath($Value) {
  if ($Value -isnot [string] -or $Value -notmatch '^[a-z]:[\\/]') { return $null }
  try { return [IO.Path]::GetFullPath($Value).TrimEnd('\','/') } catch { return $null }
}

function Test-BridgePathEqual($Left, $Right) {
  $one = Get-BridgeCanonicalPath $Left
  $two = Get-BridgeCanonicalPath $Right
  return ($one -and $two -and [string]::Equals($one, $two, [StringComparison]::OrdinalIgnoreCase))
}

function Split-BridgeProcessArguments($CommandLine) {
  # Accept canonical quoted or unquoted argv tokens. Ambiguous escaped quotes
  # are refused rather than guessed; Windows file names cannot contain quotes.
  if ($CommandLine -isnot [string] -or $CommandLine -match '\\"') { return $null }
  $tokens = New-Object 'Collections.Generic.List[string]'
  $tokenPattern = [regex]'\G\s*(?:"([^"]+)"|([^\s"]+))(?=\s|$)'
  $position = 0
  while ($position -lt $CommandLine.Length) {
    if ([string]::IsNullOrWhiteSpace($CommandLine.Substring($position))) { break }
    $match = $tokenPattern.Match($CommandLine, $position)
    if (-not $match.Success) { return $null }
    $value = if ($match.Groups[1].Success) { $match.Groups[1].Value } else { $match.Groups[2].Value }
    $tokens.Add($value)
    $position = $match.Index + $match.Length
  }
  if ($tokens.Count -eq 0) { return $null }
  return ,$tokens.ToArray()
}

function Get-BridgeProcessInfo([int]$ProcessId) {
  if ($ProcessId -lt 1) { throw 'process-identity-unavailable' }
  $found = @(Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop)
  if ($found.Count -gt 1) { throw 'process-identity-unavailable' }
  if ($found.Count -eq 0) { return $null }
  return $found[0]
}

function Get-BridgeBirthMilliseconds($Value) {
  try {
    $date = [DateTime]$Value
    if ($date.Year -lt 2000) { return $null }
    return [long][Math]::Floor($date.ToUniversalTime().Ticks / 10000.0)
  } catch { return $null }
}

function Get-BridgeGatewayProof($Health, $InstanceId, [switch]$RequireBoot) {
  if (-not $Health -or $Health.service -ne 'pocket-bridge-gateway' -or
      -not (Test-BridgeUuid $InstanceId) -or $Health.instanceId -ne $InstanceId -or
      [string]$Health.pid -notmatch '^[1-9][0-9]{0,9}$' -or
      [string]$Health.port -notmatch '^[1-9][0-9]{0,4}$' -or [int]$Health.port -gt 65535 -or
      ($RequireBoot -and -not (Test-BridgeUuid $Health.bootId))) { return $null }
  try {
    $info = Get-BridgeProcessInfo ([int]$Health.pid)
    if (-not $info -or $info.Name -ne 'node.exe' -or -not (Test-BridgePathEqual $info.ExecutablePath $NodeExe)) { return $null }
    $tokens = Split-BridgeProcessArguments $info.CommandLine
    $birth = Get-BridgeBirthMilliseconds $info.CreationDate
    if (-not $tokens -or $tokens.Count -ne 2 -or $null -eq $birth -or
        -not (Test-BridgePathEqual $tokens[0] $info.ExecutablePath) -or
        -not (Test-BridgePathEqual $tokens[1] $ProxyJs)) { return $null }
    return [pscustomobject]@{ processId = [int]$info.ProcessId; birth = $birth;
      executable = [string]$info.ExecutablePath; commandLine = [string]$info.CommandLine; health = $Health }
  } catch { return $null }
}

function Get-BridgeHealth([int]$Port) {
  return Invoke-RestMethod -Uri "http://127.0.0.1:$Port/__health" -TimeoutSec 1 -ErrorAction Stop
}

function Find-Gateway {
  $instanceId = Get-BridgeInstanceId
  if (-not $instanceId) { return $null }
  $ports = New-Object 'Collections.Generic.List[int]'
  try {
    $savedPort = (Get-Content -LiteralPath (Join-Path $LogDir 'gateway-port.txt') -Raw).Trim()
    if ($savedPort -match '^[1-9][0-9]{0,4}$' -and [int]$savedPort -le 65535) { $ports.Add([int]$savedPort) }
  } catch { }
  for ($p = 8080; $p -le 8099; $p++) { if (-not $ports.Contains($p)) { $ports.Add($p) } }
  foreach ($p in $ports) {
    try {
      $health = Get-BridgeHealth $p
      if ([int]$health.port -eq $p -and (Get-BridgeGatewayProof $health $instanceId)) { return $health }
    } catch { }
  }
  return $null
}

function Get-ConsoleStatus($port) {
  try {
    return Invoke-RestMethod -Uri "http://127.0.0.1:$port/__console/status" -TimeoutSec 3 -ErrorAction Stop
  } catch { return $null }
}

function Get-IconPath($state) {
  $f = Join-Path $IconDir "$state.ico"
  if (Test-Path $f) { return $f }
  return (Join-Path $IconDir 'grey.ico')
}

# ── 托盘 ──────────────────────────────────────────────────────────────────────
$script:Port    = 0
$script:Status  = $null
$script:Health  = $null
$script:State   = 'grey'
$script:Icon    = $null

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Visible = -not $SelfTest
$notify.Text = 'Pocket Bridge：正在检查…'

function Set-State($state, $tooltip) {
  if ($state -ne $script:State -or $null -eq $script:Icon) {
    $script:State = $state
    $path = Get-IconPath $state
    try {
      # 从文件流加载，避免系统把图标文件锁住导致重新生成失败
      $stream = [System.IO.File]::OpenRead($path)
      $script:Icon = New-Object System.Drawing.Icon($stream)
      $stream.Close()
      $notify.Icon = $script:Icon
    } catch { }
  }
  if ($tooltip) {
    # NotifyIcon 的提示文字上限 63 字符，超了会抛异常
    if ($tooltip.Length -gt 62) { $tooltip = $tooltip.Substring(0, 59) + '...' }
    $notify.Text = $tooltip
  }
}

function Refresh-State {
  $h = Find-Gateway
  $script:Health = $h

  if (-not $h) {
    $script:Port = 0
    $script:Status = $null
    Set-State 'red' 'Pocket Bridge：服务没在运行'
    return
  }

  $script:Port = $h.port
  $st = Get-ConsoleStatus $h.port
  $script:Status = $st

  $dshOk = [bool]$h.dshAlive
  $tunOk = $false
  if ($st -and $st.tunnel -and $st.tunnel.url) { $tunOk = $true }

  $mode = '动态地址'
  if ($st -and $st.domain -and $st.domain.mode -eq 'fixed') { $mode = '固定地址' }

  if ($dshOk -and $tunOk) {
    Set-State 'green' "Pocket Bridge：正常　端口 $($h.port)　$mode"
  } elseif ($dshOk -or $tunOk) {
    $what = if ($dshOk) { '外网隧道未就绪（内网仍可用）' } else { 'DSH 本体未运行' }
    Set-State 'amber' "Pocket Bridge：$what"
  } else {
    Set-State 'amber' "Pocket Bridge：端口 $($h.port) 在跑，但 DSH 与隧道都没就绪"
  }
}

# ── 剪贴板 ────────────────────────────────────────────────────────────────────
function Copy-Text($text, $what) {
  if ([string]::IsNullOrWhiteSpace($text)) {
    [System.Windows.Forms.MessageBox]::Show("现在没有可复制的$what。", 'Pocket Bridge')
    return
  }
  try {
    [System.Windows.Forms.Clipboard]::SetText($text)
    $notify.BalloonTipTitle = 'Pocket Bridge'
    $notify.BalloonTipText = "$what 已复制到剪贴板"
    $notify.ShowBalloonTip(1500)
  } catch {
    [System.Windows.Forms.MessageBox]::Show("复制失败：$($_.Exception.Message)", 'Pocket Bridge')
  }
}

# 在内网用的地址。
#
# ★ 优先给 **HTTPS 那条**（8081），没有才退回明文 http（8080）。
#
#   为什么：复制的内网入口需要优先给出可用的 HTTPS 地址，避免落到明文 HTTP。
#   原因就是这里原来直接返回 entries.lan[0] —— 那是 http://…:8080，
#   而浏览器在**非安全上下文**里不提供加密接口（crypto.subtle），
#   那条路**永远**加不了密，跟地址里带不带 #k= 没关系。
#   于是「在家用」这一项复制出来必然是明文。
#
#   内网 HTTPS（8081）也是 https，能加密、而且比绕隧道快得多 ——
#   在家就该用它。只有它没开的时候才退回 http，并在复制时提醒一句。
function Get-LanUrl {
  if (-not ($script:Status -and $script:Status.entries)) { return $null }
  $e = $script:Status.entries
  if ($e.lanHttps -and $e.lanHttps.Count -gt 0) { return $e.lanHttps[0] }
  if ($e.lan -and $e.lan.Count -gt 0) { return $e.lan[0] }
  return $null
}
# 这条地址能不能加密（只有 https 才可能）。
# 用来在只能给明文的时候，复制完提醒一句 —— 而不是让使用者自己发现「怎么没加密」。
function Test-UrlEncryptable($u) {
  return [bool]($u -and $u -like 'https://*')
}
function Get-WanUrl {
  if ($script:Status -and $script:Status.entries) { return $script:Status.entries.wan }
  return $null
}
function Get-PairCode {
  if ($script:Status -and $script:Status.entries) { return $script:Status.entries.pairCode }
  return $null
}
function Get-PairPage {
  if ($script:Status -and $script:Status.entries) { return $script:Status.entries.pairPage }
  return $null
}

# ── 起停服务 ──────────────────────────────────────────────────────────────────
# 使用者主动停止的标记。
#
# 看门狗计划任务每 5 分钟跑一次 gateway-daemon.js，一发现中间层没在跑就拉起来 ——
# 所以「停服务」如果不留个记号，最多 5 分钟就被它复活，
# 使用者看到的就是「关了，后台还在跑」。daemon 会读这个文件并跳过启动。
#
# 定义放在 Start/Stop 两个函数**之前**：PowerShell 虽然是调用时才取值，
# 但把「用到的变量」放在「用它的函数」后面，早晚会在某次改动里踩到。
$StopFlag = Join-Path $Base 'logs\user-stopped.flag'

function Start-Gateway {
  if ($script:StopInProgress -or (Test-BridgeShutdownPending)) { return }
  # 先清掉「使用者主动关闭」的标记 —— 他都来点启动了，就该正常跑起来。
  # 不清的话：daemon 读到标记会直接退出，表现是「点了启动没反应」，
  # 而且完全没有线索。
  try {
    if (Test-Path -LiteralPath $StopFlag) {
      $flag = Get-Item -LiteralPath $StopFlag -Force -ErrorAction Stop
      if ($flag.PSIsContainer -or ($flag.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return }
      Remove-Item -LiteralPath $StopFlag -Force -ErrorAction Stop
    }
  } catch { return }

  if (Find-Gateway) { return }
  # 用 wscript 起，脱离本进程 —— 客户端退出后服务继续跑
  $vbs = Join-Path $env:TEMP 'dsh-gw-start.vbs'
  $lines = @(
    'Set s = CreateObject("WScript.Shell")',
    ('s.CurrentDirectory = "' + $Base + '"'),
    ('s.Run """' + $NodeExe + '"" ""' + $DaemonJs + '""", 0, False')
  )
  [System.IO.File]::WriteAllText($vbs, ($lines -join "`r`n"), [System.Text.Encoding]::Unicode)
  Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$vbs`"" -WindowStyle Hidden

  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 1000
    if (Find-Gateway) { return }
  }
}

# （$StopFlag 已在上面定义，这里只用它。）
function Get-BridgeTunnelProofs([int]$Port) {
  $proofs = New-Object 'Collections.Generic.List[object]'
  $unverified = 0
  $tunnelExe = Join-Path $Base 'cloudflared\cloudflared.exe'
  $configPath = Join-Path $LogDir 'cloudflared-named.yml'
  $namedName = $null
  try {
    $configText = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8
    $nameMatch = [regex]::Match($configText, '(?m)^tunnel:\s*([a-zA-Z0-9._-]+)\s*$')
    $serviceMatches = [regex]::Matches($configText, '(?m)^\s*service:\s*(http://127\.0\.0\.1:[0-9]+)\s*$')
    if ($nameMatch.Success -and $serviceMatches.Count -eq 1 -and
        $serviceMatches[0].Groups[1].Value -eq "http://127.0.0.1:$Port") { $namedName = $nameMatch.Groups[1].Value }
  } catch { }
  try {
    foreach ($info in @(Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -ErrorAction Stop)) {
      if (-not (Test-BridgePathEqual $info.ExecutablePath $tunnelExe)) { continue }
      $tokens = Split-BridgeProcessArguments $info.CommandLine
      $birth = Get-BridgeBirthMilliseconds $info.CreationDate
      $owned = $false
      if ($tokens -and $null -ne $birth -and (Test-BridgePathEqual $tokens[0] $tunnelExe)) {
        $owned = ($tokens.Count -eq 5 -and $tokens[1] -ceq 'tunnel' -and $tokens[2] -ceq '--url' -and
          $tokens[3] -ceq "http://127.0.0.1:$Port" -and $tokens[4] -ceq '--no-autoupdate')
        if (-not $owned -and $namedName) {
          $owned = ($tokens.Count -eq 7 -and $tokens[1] -ceq 'tunnel' -and $tokens[2] -ceq '--config' -and
            (Test-BridgePathEqual $tokens[3] $configPath) -and $tokens[4] -ceq 'run' -and
            $tokens[5] -ceq $namedName -and $tokens[6] -ceq '--no-autoupdate')
        }
      }
      if ($owned) {
        $proofs.Add([pscustomobject]@{ processId = [int]$info.ProcessId; birth = $birth;
          executable = [string]$info.ExecutablePath; commandLine = [string]$info.CommandLine })
      } else { $unverified++ }
    }
  } catch { $unverified++ }
  return [pscustomobject]@{ proofs = @($proofs.ToArray()); unverified = $unverified }
}

function Test-BridgeSameProcess($Info, $Proof) {
  return ($Info -and [int]$Info.ProcessId -eq $Proof.processId -and
    (Get-BridgeBirthMilliseconds $Info.CreationDate) -eq $Proof.birth -and
    (Test-BridgePathEqual $Info.ExecutablePath $Proof.executable) -and
    [string]$Info.CommandLine -ceq $Proof.commandLine)
}

function Stop-BridgeOwnedTunnel($Proof) {
  $heldProcess = $null
  try {
    $heldProcess = Get-Process -Id $Proof.processId -ErrorAction Stop
    # Open and retain this exact process handle before rechecking CIM/birth.
    # Kill uses that held object, never a freshly looked-up PID.
    $null = $heldProcess.Handle
    if ((Get-BridgeBirthMilliseconds $heldProcess.StartTime) -ne $Proof.birth -or
        -not (Test-BridgeSameProcess (Get-BridgeProcessInfo $Proof.processId) $Proof)) { return $false }
    $heldProcess.Kill()
    return $heldProcess.WaitForExit(3000)
  } catch { return $false }
  finally { if ($heldProcess) { $heldProcess.Dispose() } }
}

function Get-BridgeNowMilliseconds { return [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }

function Test-BridgeDaemonOperationPending {
  # The daemon owns this atomic per-install directory while admitting or
  # completing mutations. Any presence or unreadability is pending; the tray
  # never guesses that an owner, age or nonce makes a lease safe to reclaim.
  try {
    $leasePath = Join-Path $LogDir 'daemon-operation.lock'
    $items = @(Get-Item -LiteralPath $leasePath -Force -ErrorAction Stop)
    if ($items.Count -gt 0) { return $true }
    # Windows PowerShell 5.1 can return zero items instead of PathNotFound for
    # missing literal paths containing brackets. Confirm using the literal
    # filesystem API, whose access errors still leave the operation pending.
    $null = [IO.File]::GetAttributes($leasePath)
    return $true
  } catch {
    $failure = $_.Exception
    while ($failure.InnerException) { $failure = $failure.InnerException }
    # Examine the actual exception, including wrapped .NET calls. Access
    # denial and every uncertain metadata failure must remain pending.
    if ($failure -is [Management.Automation.ItemNotFoundException] -or
        $failure -is [IO.FileNotFoundException] -or $failure -is [IO.DirectoryNotFoundException]) { return $false }
    return $true
  }
}

function Test-BridgeGatewayStartupPending([switch]$IncludeUncertain) {
  # A daemon may have admitted a new owned gateway before the stop flag. It
  # might not have a health listener yet, so health alone cannot prove absence.
  try {
    foreach ($info in @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop)) {
      if ($IncludeUncertain -and [string]::IsNullOrWhiteSpace([string]$info.ExecutablePath)) { return $true }
      if ($info.Name -ne 'node.exe' -or -not (Test-BridgePathEqual $info.ExecutablePath $NodeExe)) { continue }
      $tokens = Split-BridgeProcessArguments $info.CommandLine
      if ($IncludeUncertain -and -not $tokens) { return $true }
      if ($tokens -and $tokens.Count -eq 2 -and
          (Test-BridgePathEqual $tokens[0] $NodeExe) -and (Test-BridgePathEqual $tokens[1] $ProxyJs)) {
        # An exact owned startup is pending even if its birth cannot yet be
        # read. This is a refusal boundary, never authority to terminate it.
        return $true
      }
    }
    return $false
  } catch { return $true }
}

function Test-BridgeShutdownPending {
  if (Test-BridgeDaemonOperationPending) { return $true }
  try {
    if ($script:PendingGatewayStopHandle) {
      if (-not $script:PendingGatewayStopHandle.HasExited) { return $true }
      $script:PendingGatewayStopHandle.Dispose()
      $script:PendingGatewayStopHandle = $null
    }
    if ($script:PendingGatewayStopProof) {
      $current = Get-BridgeProcessInfo $script:PendingGatewayStopProof.processId
      if ($current -and (Test-BridgeSameProcess $current $script:PendingGatewayStopProof)) { return $true }
      $script:PendingGatewayStopProof = $null
    }
    if ((Test-Path -LiteralPath $StopFlag) -and (Test-BridgeGatewayStartupPending)) { return $true }
    return $false
  } catch { return $true }
}

function Assert-BridgeOwnedStopPaths([switch]$RequireLogs) {
  if (-not (Test-BridgePathEqual $LogDir (Join-Path $Base 'logs')) -or
      -not (Test-BridgePathEqual $StopFlag (Join-Path $LogDir 'user-stopped.flag'))) { throw 'stop-flag-unavailable' }
  # Refuse reparse-point parents before creating or touching the owned flag.
  $directory = Get-BridgeCanonicalPath $Base
  while ($directory) {
    $item = Get-Item -LiteralPath $directory -Force -ErrorAction Stop
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'stop-flag-unavailable' }
    $directory = Split-Path -Parent $directory
  }
  if (Test-Path -LiteralPath $LogDir) {
    $logItem = Get-Item -LiteralPath $LogDir -Force -ErrorAction Stop
    if (-not $logItem.PSIsContainer -or ($logItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'stop-flag-unavailable' }
  } elseif ($RequireLogs) { throw 'stop-flag-unavailable' }
}

function Write-BridgeStopFlag {
  Assert-BridgeOwnedStopPaths
  if (-not (Test-Path -LiteralPath $LogDir)) { [void][IO.Directory]::CreateDirectory($LogDir) }
  Assert-BridgeOwnedStopPaths -RequireLogs
  if (Test-Path -LiteralPath $StopFlag) {
    $existing = Get-Item -LiteralPath $StopFlag -Force -ErrorAction Stop
    if ($existing.PSIsContainer -or ($existing.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'stop-flag-unavailable' }
    return
  }
  $stream = [IO.File]::Open($StopFlag, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try {
    $bytes = [Text.Encoding]::ASCII.GetBytes((Get-Date -Format o))
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
  } finally { $stream.Dispose() }
}

function Test-BridgeInstalledTunnelPending {
  try {
    $tunnelExe = Join-Path $Base 'cloudflared\cloudflared.exe'
    foreach ($info in @(Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -ErrorAction Stop)) {
      if (-not $info -or [string]::IsNullOrWhiteSpace([string]$info.ExecutablePath) -or
          (Test-BridgePathEqual $info.ExecutablePath $tunnelExe)) { return $true }
    }
    return $false
  } catch { return $true }
}

function Test-BridgeAlreadyStoppedFences($InstanceId) {
  try {
    Assert-BridgeOwnedStopPaths -RequireLogs
    if (-not (Test-BridgeUuid $InstanceId) -or (Get-BridgeInstanceId) -ne $InstanceId -or
        (Test-BridgeShutdownPending) -or (Test-BridgeGatewayStartupPending -IncludeUncertain) -or
        (Test-BridgeInstalledTunnelPending) -or (Test-BridgeDaemonOperationPending)) { return $false }
    return $true
  } catch { return $false }
}

function Get-BridgeAlreadyStoppedResult($InstanceId) {
  if (-not (Test-BridgeAlreadyStoppedFences $InstanceId)) { return $null }
  try { Write-BridgeStopFlag } catch { return $null }
  # Writing stop intent is not evidence of absence. Repeat every fence before
  # allowing Quit or key rotation to treat an idle installation as stopped.
  if (-not (Test-BridgeAlreadyStoppedFences $InstanceId)) { return $null }
  return @{ ok = $true; alreadyStopped = $true; gatewayStopped = $true; tunnelsStopped = 0;
    message = 'This installation is already stopped. Automatic restart is paused.' }
}

function Set-BridgeStopControls([bool]$Stopping) {
  if ($Stopping) {
    $script:StopControls = @()
    foreach ($item in @($miStart, $miStop, $miKeys, $miTargets, $miAuto, $miQuit, $miConsole, $miPicker)) {
      if ($null -ne $item) {
        $script:StopControls += @{ item = $item; enabled = $item.Enabled }
        $item.Enabled = $false
      }
    }
  } else {
    foreach ($record in $script:StopControls) { $record.item.Enabled = $record.enabled }
    $script:StopControls = @()
  }
}

function Pump-BridgeStopEvents { [System.Windows.Forms.Application]::DoEvents() }

function Stop-Gateway {
  if ($script:StopInProgress) { return @{ ok = $false; code = 'shutdown-pending'; message = 'Gateway shutdown is already pending.' } }
  $script:StopInProgress = $true
  $gatewayHandle = $null
  try {
    Set-BridgeStopControls $true
    $instanceId = Get-BridgeInstanceId
    $health = Find-Gateway
    $proof = Get-BridgeGatewayProof $health $instanceId -RequireBoot
    if (-not $proof) {
      $idle = Get-BridgeAlreadyStoppedResult $instanceId
      if ($idle) { return $idle }
      return @{ ok = $false; code = 'identity-unverified'; message = 'This installation could not verify a gateway with controlled shutdown support or confirm it is fully stopped. No processes were stopped.' }
    }
    $fresh = Get-BridgeGatewayProof (Get-BridgeHealth ([int]$health.port)) $instanceId -RequireBoot
    if (-not $fresh -or $fresh.birth -ne $proof.birth -or $fresh.health.bootId -ne $health.bootId -or
        $fresh.processId -ne $proof.processId) { return @{ ok = $false; code = 'gateway-replaced'; message = 'Gateway identity changed. No processes were stopped.' } }
    if ($script:PendingGatewayStopHandle -and -not $script:PendingGatewayStopHandle.HasExited -and
        (-not $script:PendingGatewayStopProof -or $script:PendingGatewayStopProof.processId -ne $proof.processId -or
         $script:PendingGatewayStopProof.birth -ne $proof.birth)) {
      return @{ ok = $false; code = 'shutdown-pending'; message = 'The original gateway process is still draining. Its held identity was preserved; no other gateway was stopped.' }
    }
    $gatewayHandle = Get-Process -Id $proof.processId -ErrorAction Stop
    $null = $gatewayHandle.Handle
    if ((Get-BridgeBirthMilliseconds $gatewayHandle.StartTime) -ne $proof.birth -or
        -not (Test-BridgeSameProcess (Get-BridgeProcessInfo $proof.processId) $proof)) {
      return @{ ok = $false; code = 'gateway-replaced'; message = 'Gateway process identity changed. No processes were stopped.' }
    }
    # The watchdog pause is written only after ownership is verified and before
    # requesting the authenticated, exact-boot loopback shutdown.
    Write-BridgeStopFlag
    $script:PendingGatewayStopProof = $proof
    if ($script:PendingGatewayStopHandle) { $script:PendingGatewayStopHandle.Dispose() }
    $script:PendingGatewayStopHandle = $gatewayHandle
    $body = @{ action = 'stop-gateway'; expectedBootId = $health.bootId; expectedInstanceId = $instanceId } | ConvertTo-Json -Compress
    $origin = "http://127.0.0.1:$($health.port)"
    $accepted = Invoke-RestMethod -Uri "$origin/__console/action" -Method Post -Headers @{ Origin = $origin } `
      -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 5 -ErrorAction Stop
    if ($accepted.ok -ne $true -or $accepted.stopping -ne $true -or $accepted.shutdownScheduled -ne $true -or
        $accepted.bootId -ne $health.bootId -or $accepted.instanceId -ne $instanceId -or [int]$accepted.pid -ne $proof.processId) {
      return @{ ok = $false; code = 'shutdown-unconfirmed'; message = 'Gateway shutdown was not confirmed. Processes were left unchanged; automatic restart is paused.' }
    }
    $deadline = (Get-BridgeNowMilliseconds) + 95000
    $exited = $false
    while ((Get-BridgeNowMilliseconds) -lt $deadline) {
      $observed = $null
      try { $observed = Get-BridgeHealth ([int]$health.port) } catch { }
      if ($observed -and ($observed.service -ne 'pocket-bridge-gateway' -or $observed.bootId -ne $health.bootId -or
          $observed.instanceId -ne $instanceId -or [int]$observed.pid -ne $proof.processId)) {
        return @{ ok = $false; code = 'gateway-replaced'; message = 'A different gateway appeared during shutdown. Its processes and tunnels were left unchanged.' }
      }
      $current = Get-BridgeProcessInfo $proof.processId
      if (-not $current) {
        if (-not $observed -and $gatewayHandle.HasExited -and -not (Test-BridgeDaemonOperationPending)) { $exited = $true; break }
      } elseif (-not (Test-BridgeSameProcess $current $proof)) {
        return @{ ok = $false; code = 'process-replaced'; message = 'The gateway process identity changed. Its processes and tunnels were left unchanged.' }
      }
      Start-Sleep -Milliseconds 250
      Pump-BridgeStopEvents
    }
    if (-not $exited) { return @{ ok = $false; code = 'shutdown-pending'; message = 'Gateway shutdown is still pending or blocked. No process was forced to stop; automatic restart is paused.' } }
    if (Test-BridgeGatewayStartupPending) {
      return @{ ok = $false; code = 'shutdown-pending'; message = 'Another gateway from this installation is starting or its absence could not be confirmed. No process was forced to stop; automatic restart is paused.' }
    }
    # Recapture after the daemon lease has drained: an admitted operation may
    # have handed off a known tunnel after the original stop request.
    $tunnels = Get-BridgeTunnelProofs ([int]$health.port)
    if ((Test-BridgeDaemonOperationPending) -or (Test-BridgeGatewayStartupPending)) {
      return @{ ok = $false; code = 'shutdown-pending'; message = 'This installation still has a pending daemon or gateway operation. Its tunnels were left unchanged; automatic restart is paused.' }
    }
    $script:PendingGatewayStopProof = $null
    $script:PendingGatewayStopHandle = $null
    # A scheduled response is not completion. Only physical disappearance of
    # the exact gateway and a quiescent daemon permit stopping fresh proofs.
    $stopped = 0
    $pending = [int]$tunnels.unverified
    foreach ($tunnel in $tunnels.proofs) {
      if (Stop-BridgeOwnedTunnel $tunnel) { $stopped++ } else { $pending++ }
    }
    if ((Test-BridgeDaemonOperationPending) -or (Test-BridgeGatewayStartupPending)) {
      return @{ ok = $false; code = 'shutdown-pending'; tunnelsStopped = $stopped;
        message = "Stopped $stopped verified tunnel(s), but this installation still has a pending daemon or gateway operation. Automatic restart is paused." }
    }
    if ($pending) { return @{ ok = $false; gatewayStopped = $true; code = 'tunnel-unconfirmed'; tunnelsStopped = $stopped;
      message = "Gateway stopped. Stopped $stopped verified tunnel(s); remaining tunnel status is unconfirmed." } }
    return @{ ok = $true; gatewayStopped = $true; tunnelsStopped = $stopped;
      message = "Gateway stopped safely. Stopped $stopped verified tunnel(s). Other installations were not changed." }
  } catch { return @{ ok = $false; code = 'shutdown-unconfirmed'; message = 'Gateway shutdown could not be confirmed. No forced gateway stop was attempted.' } }
  finally {
    if ($gatewayHandle -and $gatewayHandle -ne $script:PendingGatewayStopHandle) { $gatewayHandle.Dispose() }
    $script:StopInProgress = $false
    Set-BridgeStopControls $false
  }
}

# ── 开机自启 ──────────────────────────────────────────────────────────────────
function Get-AutostartPath {
  return (Join-Path ([Environment]::GetFolderPath('Startup')) 'Pocket Bridge.lnk')
}
function Test-Autostart { return (Test-Path (Get-AutostartPath)) }
function Set-Autostart($on) {
  $installer = Join-Path $Base 'scripts\install-autostart.js'
  $action = if ($on) { 'install' } else { 'uninstall' }
  & $NodeExe $installer $action | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "设置开机自启失败：$action" }
}

# ── 菜单 ──────────────────────────────────────────────────────────────────────
$menu = New-Object System.Windows.Forms.ContextMenuStrip

function New-Item2($text, $action, $enabled = $true) {
  $it = New-Object System.Windows.Forms.ToolStripMenuItem($text)
  $it.Enabled = $enabled
  if ($action) { $it.add_Click($action) }
  return $it
}

$miHeader = New-Item2 '正在检查…' $null $false
$menu.Items.Add($miHeader) | Out-Null
$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

$miConsole = New-Item2 '打开控制台' {
  if ($script:StopInProgress) { return }
  if (-not $script:Port) { Start-Gateway }
  Refresh-State
  if (-not $script:Port) {
    [System.Windows.Forms.MessageBox]::Show('服务起不来。请看 logs\daemon.log。', 'Pocket Bridge')
    return
  }
  Start-Process -FilePath $NodeExe -ArgumentList "`"$OpenAppJs`"", "$($script:Port)", 'console' -WindowStyle Hidden
}
$menu.Items.Add($miConsole) | Out-Null

$miPicker = New-Item2 '连接方式与测速' {
  if ($script:StopInProgress) { return }
  if (-not $script:Port) { Start-Gateway }
  Refresh-State
  if (-not $script:Port) { return }
  Start-Process -FilePath $NodeExe -ArgumentList "`"$OpenAppJs`"", "$($script:Port)", 'go' -WindowStyle Hidden
}
$menu.Items.Add($miPicker) | Out-Null

$miPhone = New-Item2 '在手机上打开控制台' {
  $u = Get-LanUrl
  if (-not $u) { $u = Get-WanUrl }
  if (-not $u) {
    [System.Windows.Forms.MessageBox]::Show('还没有可用入口。先启动服务。', 'Pocket Bridge')
    return
  }
  Start-Process $u
}
$menu.Items.Add($miPhone) | Out-Null

$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

# 复制地址。
#
# 菜单文字里把「加密」写出来 —— 使用者之前就是从「复制内网地址」拿到一条明文地址，
# 然后在手机上看见「未加密」，回头问「你是不是把地址弄错了」。
# 名字里不写清楚，他没有任何办法在复制之前知道这一条是不是加密的。
$miCopyLan = New-Item2 '复制地址 · 在家用' {
  $u = Get-LanUrl
  Copy-Text $u '在家用的地址'
  if ($u -and -not (Test-UrlEncryptable $u)) {
    # 只能给明文的时候必须说一声，否则他又要自己去手机上发现
    $notify.BalloonTipTitle = 'Pocket Bridge'
    $notify.BalloonTipText = "这条是明文 http，手机上看不到加密。`n" +
      "想要加密：控制台 → 设置 → 开启内网 HTTPS。"
    $notify.ShowBalloonTip(6000)
  }
}
$menu.Items.Add($miCopyLan) | Out-Null
$miCopyWan = New-Item2 '复制地址 · 在外面用' {
  $u = Get-WanUrl
  Copy-Text $u '在外面用的地址'
  if ($u -and -not (Test-UrlEncryptable $u)) {
    $notify.BalloonTipTitle = 'Pocket Bridge'
    $notify.BalloonTipText = '这条不是 https，手机上看不到加密。'
    $notify.ShowBalloonTip(6000)
  }
}
$menu.Items.Add($miCopyWan) | Out-Null
$miCopyPair = New-Item2 '复制配对码（手机输这 6 位）' { Copy-Text (Get-PairCode) '配对码' }
$menu.Items.Add($miCopyPair) | Out-Null
$miCopyPairUrl = New-Item2 '复制配对页地址（给二维码用）' { Copy-Text (Get-PairPage) '配对页地址' }
$menu.Items.Add($miCopyPairUrl) | Out-Null

$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

$miStart = New-Item2 '启动服务' {
  Start-Gateway
  Refresh-State
}
$menu.Items.Add($miStart) | Out-Null

$miStop = New-Item2 '停止服务' {
  $r = [System.Windows.Forms.MessageBox]::Show(
    '停止后手机就连不上了（包括内网）。确定吗？', 'Pocket Bridge',
    [System.Windows.Forms.MessageBoxButtons]::YesNo,
    [System.Windows.Forms.MessageBoxIcon]::Warning)
  if ($r -eq [System.Windows.Forms.DialogResult]::Yes) {
    $result = Stop-Gateway
    Refresh-State
    $notify.BalloonTipTitle = 'Pocket Bridge'
    $notify.BalloonTipText = [string]$result.message
    $notify.ShowBalloonTip(4000)
    if (-not $result.ok) { [void][System.Windows.Forms.MessageBox]::Show([string]$result.message, 'Pocket Bridge') }
  }
}
$menu.Items.Add($miStop) | Out-Null

# ── 电脑上跑的 DSH──────────────────────────────────────────────
#
# 起停逻辑走网关的 HTTP 接口，不在客户端里重写一遍 ——
# 两处各写一份的话行为迟早会不一致（比如「Codex 只停自己起的那个、不动桌面版」
# 这种细节，重写一遍很容易漏掉）。
function Invoke-TargetAction($id, $action) {
  if ($script:StopInProgress) { return }
  if (-not $script:Port) { Start-Gateway }
  Refresh-State
  if (-not $script:Port) {
    [System.Windows.Forms.MessageBox]::Show('服务没在运行，先把它起来。', 'Pocket Bridge')
    return
  }
  try {
    $body = @{ target = $id; action = $action } | ConvertTo-Json -Compress
    $r = Invoke-RestMethod -Uri "http://127.0.0.1:$($script:Port)/__targets/action" `
      -Method Post -ContentType 'application/json; charset=utf-8' `
      -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 120
    $notify.BalloonTipTitle = 'Pocket Bridge'
    $notify.BalloonTipText = [string]$r.message
    $notify.ShowBalloonTip(2500)
  } catch {
    [System.Windows.Forms.MessageBox]::Show("操作失败：$($_.Exception.Message)", 'Pocket Bridge')
  }
  Refresh-State
}

$miTargets = New-Object System.Windows.Forms.ToolStripMenuItem('电脑上跑的东西')
foreach ($t in @(@{ id = 'dsh'; nm = 'DSH' })) {
  $sub = New-Object System.Windows.Forms.ToolStripMenuItem($t.nm)
  $tid = $t.id
  $sub.DropDownItems.Add((New-Item2 '启动' { Invoke-TargetAction $tid 'start' })) | Out-Null
  $sub.DropDownItems.Add((New-Item2 '停止' { Invoke-TargetAction $tid 'stop' })) | Out-Null
  $miTargets.DropDownItems.Add($sub) | Out-Null
}
$menu.Items.Add($miTargets) | Out-Null

$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

# 换密钥的两项收进一个子菜单。
#
# 为什么：它们原来散在菜单里，各自单独一行，而下面还有一个「刷新」——
# 使用者想换加密密钥时点到了「刷新（重新读取状态和地址）」，然后问
# 「点了刷新怎么没反应？」。那不是他点错了，是**菜单没把「刷新状态」和
# 「换密钥」区分开**：两者看起来都是「让某个东西更新一下」。
#
# 收进「密钥」子菜单之后，换密钥这件事只有一个入口，不会再和刷新混淆。
$miKeys = New-Object System.Windows.Forms.ToolStripMenuItem('密钥')

$miRotate = New-Item2 '轮换访问密钥…' {
  $r = [System.Windows.Forms.MessageBox]::Show(
    "轮换后会换一把新钥匙，已经配对的手机需要重新配对（用配对码即可）。`n`n" +
    "什么时候该换：链接可能被别人看到过、手机丢了、或者只是过一段时间想换一次。`n`n继续吗？",
    'Pocket Bridge', [System.Windows.Forms.MessageBoxButtons]::YesNo,
    [System.Windows.Forms.MessageBoxIcon]::Question)
  if ($r -ne [System.Windows.Forms.DialogResult]::Yes) { return }

  $stopped = Stop-Gateway
  if (-not $stopped.ok) {
    [void][System.Windows.Forms.MessageBox]::Show([string]$stopped.message, 'Pocket Bridge')
    return
  }
  $out = & $NodeExe $RotateJs --revoke-sessions 2>&1 | Out-String
  Start-Gateway
  Refresh-State
  [System.Windows.Forms.MessageBox]::Show("已轮换。`n`n$out", 'Pocket Bridge')
}
$miKeys.DropDownItems.Add($miRotate) | Out-Null

# 更换「加密密钥」—— 跟上面那个「访问密钥」是两码事，菜单里要写清楚区别。
#
#   访问密钥：决定「谁能连进来」。换它 = 把门锁换掉，旧手机要重新配对。
#   加密密钥：决定「隧道能不能看懂内容」。换它 = 换一把只有你手机和电脑知道的钥匙，
#             不影响谁能连进来，但**手机书签里的地址会失效**（密钥在地址的 # 后面）。
$miRotateE2ee = New-Item2 '更换加密密钥…' {
  $has = Test-Path (Join-Path $Base 'logs\e2ee-secret.txt')
  $msg = if ($has) {
    "这会换一把新的加密密钥。`n`n" +
    "· 隧道（Cloudflare）看不到内容这件事不受影响 —— 换完照样看不到`n" +
    "· **手机书签会失效**：密钥在地址的 # 后面，换了地址就变了`n" +
    "· 换完新地址会显示在**下一个弹窗**里，你复制到手机即可`n" +
    "  （手机在这之前是明文模式，界面上会显示「未加密」，功能不受影响）`n" +
    "· 同时会给手机推一条提醒，叫你回来拿新链接 —— 提醒里**不带密钥**`n`n" +
    "什么时候该换：怀疑密钥泄露、或者只是想定期换一次。`n`n继续吗？"
  } else {
    "现在还没有加密密钥（所以走隧道时内容是明文）。`n`n" +
    "生成之后：`n" +
    "· 手机用带 #密钥 的地址打开，对话内容、图片、文件就都加密了`n" +
    "· 不带 #密钥 的旧地址仍然能用，只是不加密`n`n现在生成吗？"
  }
  $r = [System.Windows.Forms.MessageBox]::Show($msg, 'Pocket Bridge — 更换加密密钥',
    [System.Windows.Forms.MessageBoxButtons]::YesNo,
    [System.Windows.Forms.MessageBoxIcon]::Question)
  if ($r -ne [System.Windows.Forms.DialogResult]::Yes) { return }

  # 带上 --notify：上面那段话承诺了「会给手机推一条提醒」，就得真的推。
  #
  # 这里原来既没带参数、提示里又写着「换完我会把带新密钥的地址推到你手机上」——
  # 而 rotate-e2ee.js 早就改成默认不推了（旧版推送会把密钥正文递给 ntfy.sh，
  # 那是端到端加密最不该做的事）。于是**承诺的推送从来没发生过**。
  #
  # 现在两边对齐：推，但只推「回电脑前拿新链接」这条提醒，密钥本身永远不走推送。
  $out = & $NodeExe (Join-Path $Base 'scripts\rotate-e2ee.js') '--notify' 2>&1 | Out-String
  Refresh-State
  [System.Windows.Forms.MessageBox]::Show($out, 'Pocket Bridge — 加密密钥已更换')
}
$miKeys.DropDownItems.Add($miRotateE2ee) | Out-Null
$menu.Items.Add($miKeys) | Out-Null

$miAuto = New-Item2 '开机自动运行' { }
$miAuto.CheckOnClick = $true
$miAuto.Checked = Test-Autostart
$miAuto.add_Click({
  try {
    Set-Autostart $miAuto.Checked
  } catch {
    $miAuto.Checked = -not $miAuto.Checked
    [System.Windows.Forms.MessageBox]::Show("设置失败：$($_.Exception.Message)", 'Pocket Bridge')
  }
})
$menu.Items.Add($miAuto) | Out-Null

$miSelfCheck = New-Item2 '跑一遍自检…' {
  if (-not $script:Port) { Start-Gateway }
  Refresh-State
  $out = & $NodeExe (Join-Path $Base 'scripts\self-check.js') 2>&1 | Out-String
  $form = New-Object System.Windows.Forms.Form
  $form.Text = 'Pocket Bridge — 自检结果'
  $form.Size = New-Object System.Drawing.Size(760, 560)
  $form.StartPosition = 'CenterScreen'
  $tb = New-Object System.Windows.Forms.TextBox
  $tb.Multiline = $true
  $tb.ScrollBars = 'Both'
  $tb.Dock = 'Fill'
  $tb.Font = New-Object System.Drawing.Font('Consolas', 9)
  $tb.ReadOnly = $true
  $tb.Text = $out
  $tb.WordWrap = $false
  $form.Controls.Add($tb)
  [void]$form.ShowDialog()
}
$menu.Items.Add($miSelfCheck) | Out-Null

$miLogs = New-Item2 '打开日志目录' { Start-Process explorer.exe $LogDir }
$menu.Items.Add($miLogs) | Out-Null

$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

# 名字里必须写明「不改密钥」。
#
# 使用者想换加密密钥时点到了这一项，然后问「点了刷新怎么没反应」——
# 他不是点错了，是这两件事在菜单里长得太像：都像是「让某个东西更新一下」。
# 换密钥现在收进「密钥」子菜单了，这一项也把「不改密钥」写在名字上，
# 两边一起把歧义消掉。
$miRefresh = New-Item2 '刷新状态和地址（不改密钥）' {
  Refresh-State
  $w = Get-WanUrl
  $notify.BalloonTipTitle = 'Pocket Bridge'
  $notify.BalloonTipText = "已刷新`n$(if ($w) { $w } else { '（外网地址未就绪）' })"
  $notify.ShowBalloonTip(2500)
}
$menu.Items.Add($miRefresh) | Out-Null

$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

# 退出。
#
# 原来这里是两项并排：「退出客户端（服务继续运行）」和「完全关闭（停服务 + 关隧道）」。
# 使用者反馈「客户端无法真正关闭，关闭客户端后后台还在运行」——
# 他不是没看见第二项，是**点第一项时那句话没让他意识到后台还在跑**。
# 菜单里写「服务继续运行」和真的看到手机上还连着，是两回事。
#
# 所以改成**当场问**，三选一，把「后台要不要一起停」变成必须回答的问题：
#   是   = 全停（手机立刻连不上）
#   否   = 只收托盘，后台继续跑
#   取消 = 什么都不做（误点了可以退出来）
$miQuit = New-Item2 '退出…' {
  $r = [System.Windows.Forms.MessageBox]::Show(
    "退出客户端。`n`n" +
    "后台的网关和隧道要不要也一起停掉？`n`n" +
    "· 选「是」= 完全关闭。手机立刻连不上（包括在外面的时候），`n" +
    "  托盘图标消失。下次双击桌面图标重新启动。`n`n" +
    "· 选「否」= 只收起托盘图标，后台继续跑。`n" +
    "  手机上照样能用，但电脑这边没有图标可点了 ——`n" +
    "  想再打开控制台，去开始菜单或桌面双击网关图标。`n`n" +
    "· 选「取消」= 什么都不做。",
    'Pocket Bridge — 退出',
    [System.Windows.Forms.MessageBoxButtons]::YesNoCancel,
    [System.Windows.Forms.MessageBoxIcon]::Question)

  if ($r -eq [System.Windows.Forms.DialogResult]::Cancel) { return }

  if ($r -eq [System.Windows.Forms.DialogResult]::Yes) {
    $notify.BalloonTipTitle = 'Pocket Bridge'
    $notify.BalloonTipText = '正在关闭服务…'
    $notify.ShowBalloonTip(2000)
    $stopped = Stop-Gateway
    if (-not $stopped.ok) {
      [void][System.Windows.Forms.MessageBox]::Show([string]$stopped.message, 'Pocket Bridge')
      return
    }
  }

  $notify.Visible = $false
  [System.Windows.Forms.Application]::Exit()
}
$menu.Items.Add($miQuit) | Out-Null

# 原来这里还有一项「完全关闭（停服务 + 关隧道）」，已删。
# 它和「退出客户端」并排摆着，本意是「把两种退出分清楚」，
# 实际效果相反：两项都叫「关闭」，使用者根本分不清哪个关的是什么 ——
# 反馈就是「客户端无法真正关闭」。现在统一收进上面那个「退出…」，
# 由那个对话框当场问清楚。**一个入口，一次选择**，没有歧义。

$notify.ContextMenuStrip = $menu

# 左键单击直接开控制台 —— 最常用的动作不该藏在右键菜单里
$notify.add_MouseClick({
  param($sender, $e)
  if ($script:StopInProgress) { return }
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
    if (-not $script:Port) { Start-Gateway }
    Refresh-State
    if ($script:Port) {
      Start-Process -FilePath $NodeExe -ArgumentList "`"$OpenAppJs`"", "$($script:Port)", 'console' -WindowStyle Hidden
    }
  }
})

# ── 定时刷新 ──────────────────────────────────────────────────────────────────
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.add_Tick({
  if ($script:StopInProgress) { return }
  try { Refresh-State } catch { }
  try {
    $miHeader.Text = if ($script:Port) {
      "服务运行中 · 端口 $($script:Port)"
    } else {
      '服务没有运行'
    }
    $miAuto.Checked = Test-Autostart
    $has = [bool]$script:Port
    $miConsole.Enabled = $true
    $miPicker.Enabled = $has
    $miPhone.Enabled = ($has -and ((Get-LanUrl) -or (Get-WanUrl)))
    $miCopyLan.Enabled = [bool](Get-LanUrl)
    $miCopyWan.Enabled = [bool](Get-WanUrl)
    $miCopyPair.Enabled = [bool](Get-PairCode)
    $miCopyPairUrl.Enabled = [bool](Get-PairPage)
    $miStart.Enabled = (-not $has -and -not $script:StopInProgress -and -not (Test-BridgeShutdownPending))
    $miStop.Enabled = ($has -and -not $script:StopInProgress)
  } catch { }
})
$timer.Start()

Refresh-State

# ── 已经有一个在跑 / 带 -OpenConsole：决定要不要把控制台叫出来 ──────────────
#
# 桌面快捷方式带 -OpenConsole。两种情况下都要把控制台窗口打开：
#   1. 第一次启动（$gotMutex = true）—— 使用者双击图标，期待看到界面，
#      而不是「屏幕上什么都没发生、右下角多了个小图标」
#   2. 已经有一个在跑（$gotMutex = false）—— 双击一个已经开着的程序，
#      正确的反应是把它的窗口带到前面
#
# 原来第 2 种情况是弹 MessageBox「客户端已经在运行了」。而快捷方式带的是
# -WindowStyle Hidden —— **那个框看不见**，于是第二个实例永远卡在脚本开头：
# 进程在、界面没反应、图标也没多。实测就是这么卡住的。
if (-not $SelfTest) {
  if ($OpenConsole) {
    if (-not $script:Port) { Start-Gateway }
    Refresh-State
    if ($script:Port) {
      Start-Process -FilePath $NodeExe -ArgumentList "`"$OpenAppJs`"", "$($script:Port)", 'console' -WindowStyle Hidden
    }
  }

  if (-not $gotMutex) {
    # 已经有一个托盘在跑了：这个实例只负责把控制台叫出来，然后退场。
    #
    # ★ 必须用 exit，**不能**用 [System.Windows.Forms.Application]::Exit()。
    #   Application::Exit() 只在消息循环（Application::Run()）跑起来之后才有效，
    #   而这里在 Run() **之前** —— 它是个空操作，实测真的叠出了第二个图标。
    #   没有报错、只是图标多了一个，很难联想到「Exit 调早了」。
    $notify.Visible = $false
    exit
  }
}

# ── 自检模式：验完就退 ────────────────────────────────────────────────────────
if ($SelfTest) {
  $bad = 0
  function Say($okFlag, $msg) {
    if ($okFlag) { Write-Output "  OK   $msg" }
    else { Write-Output "  FAIL $msg"; $script:bad++ }
  }

  Write-Output ''
  Write-Output 'Pocket Bridge 客户端 — 自检'
  Write-Output ('=' * 56)

  Say (Test-Path $NodeExe) "node 可用: $NodeExe"
  Say ($null -ne $notify) '托盘对象创建成功'
  Say ($null -ne $menu) "右键菜单项 $($menu.Items.Count) 条"
  Say ($null -ne $timer) '状态刷新定时器创建成功'

  # 四种状态的图标都要能真的加载出来 —— 路径写错的话运行时只会静默不出图标
  foreach ($s in @('green', 'amber', 'red', 'grey')) {
    $p = Get-IconPath $s
    $loaded = $false
    try {
      $fs2 = [System.IO.File]::OpenRead($p)
      $ic = New-Object System.Drawing.Icon($fs2)
      $loaded = ($ic.Width -gt 0)
      $ic.Dispose()
      $fs2.Close()
    } catch { }
    Say $loaded "图标 $s.ico 可加载"
  }

  Write-Output ''
  if ($script:Port) {
    Say $true "读到服务：端口 $($script:Port)，DSH 后端 $($script:Health.dshPort)，DSH 存活 $($script:Health.dshAlive)"
    Say ($null -ne $script:Status) '能读到控制台状态'
    if ($script:Status) {
      Say ([bool](Get-LanUrl)) "内网入口: $(Get-LanUrl)"
      Say ([bool](Get-WanUrl)) "外网入口: $(Get-WanUrl)"
      Say ([bool](Get-PairCode)) "配对码: $(Get-PairCode)"
      $dm = $script:Status.domain
      if ($dm) { Say $true "地址策略: $($dm.modeLabel)" }
    }
  } else {
    # 服务没跑不是客户端的错，但如果连「找不到」这件事都判断不出来就是错的
    Say $true '服务未运行（客户端已正确识别，图标应为红色）'
  }

  Write-Output ''
  Write-Output ('=' * 56)
  Write-Output "结果: $(if ($bad) { "$bad 项失败" } else { '全部通过' })"
  Write-Output "当前状态图标: $script:State"

  $notify.Dispose()
  try { if ($gotMutex) { $mutex.ReleaseMutex() } } catch { }
  exit $(if ($bad) { 1 } else { 0 })
}

# 第一次启动给个提示，否则用户不知道它跑起来了
$notify.BalloonTipTitle = 'Pocket Bridge 客户端'
$notify.BalloonTipText = if ($script:Port) {
  "已就绪。左键点图标打开控制台。"
} else {
  "服务没在跑。左键点图标即可启动。"
}
$notify.ShowBalloonTip(2500)

[System.Windows.Forms.Application]::Run()

# 退出时清理：图标必须显式隐藏，否则会残留在托盘里直到鼠标划过
$timer.Stop()
$notify.Visible = $false
$notify.Dispose()
try { $mutex.ReleaseMutex() } catch { }
