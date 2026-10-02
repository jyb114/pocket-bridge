param(
  [string]$OutDir = '',
  [string]$WorkBase = '',
  [switch]$SkipInstallTest
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not $OutDir) { $OutDir = Join-Path $root 'dist' }
$OutDir = [IO.Path]::GetFullPath($OutDir)
$version = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
if ($version -notmatch '^(\d+\.\d+\.\d+)(?:-preview\.\d+)?$') { throw "Unsupported package version: $version" }
$numericVersion = $Matches[1]

# All downloaded executables are pinned to known hashes. The NSIS mirror has
# the same bytes as the canonical NSIS release-data entry.
$nodeVersion = '24.18.1'
$nodeHash = 'AC51903C4C111815D52280B1FDCC8DA067CBB37E2FE1A765097B85C3292C8582'
$nodeZipHash = 'EC56B84A7551893AB2324EBDFDC4AB974A63B4781162600B68A1293CC3E53765'
$cloudflaredVersion = '2026.9.1'
$cloudflaredHash = '2837888CC0F5D58F15B6DC478376DE90B4D3BA5241C7947455D1E0A0DF429712'
$nsisVersion = '3.11'
$nsisHash = 'C7D27F780DDB6CFFB4730138CD1591E841F4B7EDB155856901CDF5F214394FA1'

function Assert-Hash([string]$file, [string]$expected) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing file: $file" }
  $actual = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
  if ($actual -ne $expected) { throw "SHA256 mismatch for $file`: $actual" }
}

function Acquire-File([string]$local, [string]$url, [string]$destination, [string]$sha256) {
  $parent = Split-Path -Parent $destination
  New-Item -ItemType Directory -Path $parent -Force | Out-Null
  if ($local -and (Test-Path -LiteralPath $local -PathType Leaf)) {
    Assert-Hash $local $sha256
    Copy-Item -LiteralPath $local -Destination $destination
  } else {
    Write-Host "Downloading $url"
    Invoke-WebRequest -Uri $url -OutFile $destination -MaximumRedirection 10
  }
  Assert-Hash $destination $sha256
}

function Acquire-License([string]$local, [string]$url, [string]$destination) {
  if ($local -and (Test-Path -LiteralPath $local -PathType Leaf)) {
    Copy-Item -LiteralPath $local -Destination $destination
  } else {
    Invoke-WebRequest -Uri $url -OutFile $destination -MaximumRedirection 10
  }
  if ((Get-Item -LiteralPath $destination).Length -lt 1000) {
    throw "Third-party license looks incomplete: $destination"
  }
}

$tempBase = if ($WorkBase) { [IO.Path]::GetFullPath($WorkBase) } else { [IO.Path]::GetFullPath([IO.Path]::GetTempPath()) }
New-Item -ItemType Directory -Path $tempBase -Force | Out-Null
$work = Join-Path $tempBase ("pocket-bridge-win-build-{0}-{1}" -f $PID, [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
try {
  $payload = Join-Path $work 'payload'
  $nodeCommand = (Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source
  if (-not $nodeCommand) { $nodeCommand = Join-Path $root "runtime\node-v$nodeVersion-win-x64\node.exe" }
  if (-not (Test-Path -LiteralPath $nodeCommand)) { throw 'Node.js is needed to stage tracked source files' }
  # Check directory/language defaults and the marked smoke's shared-state
  # boundary without invoking NSIS, reading user keys, or installing anything.
  & $nodeCommand (Join-Path $root 'scripts\test-windows-installer.js')
  if ($LASTEXITCODE -ne 0) { throw 'Windows installer source contract failed' }
  & $nodeCommand (Join-Path $PSScriptRoot 'stage.js') $payload
  if ($LASTEXITCODE -ne 0) { throw 'Source staging failed' }

  $nodeDir = Join-Path $payload "runtime\node-v$nodeVersion-win-x64"
  $cloudDir = Join-Path $payload 'cloudflared'
  New-Item -ItemType Directory -Path $nodeDir, $cloudDir -Force | Out-Null
  $localNode = Join-Path $root "runtime\node-v$nodeVersion-win-x64\node.exe"
  $localNodeLicense = Join-Path $root "runtime\node-v$nodeVersion-win-x64\LICENSE"
  if ((Test-Path -LiteralPath $localNode -PathType Leaf) -and
      (Test-Path -LiteralPath $localNodeLicense -PathType Leaf)) {
    Acquire-File $localNode '' (Join-Path $nodeDir 'node.exe') $nodeHash
    Acquire-License $localNodeLicense '' (Join-Path $nodeDir 'LICENSE')
  } else {
    # The Node release root has no standalone LICENSE URL. Extract it and the
    # executable from the official, SHA256-pinned Windows archive.
    $nodeZip = Join-Path $work "node-v$nodeVersion-win-x64.zip"
    Acquire-File '' "https://nodejs.org/dist/v$nodeVersion/node-v$nodeVersion-win-x64.zip" $nodeZip $nodeZipHash
    $nodeArchive = Join-Path $work 'node-archive'
    Expand-Archive -LiteralPath $nodeZip -DestinationPath $nodeArchive
    $unpackedNode = Join-Path $nodeArchive "node-v$nodeVersion-win-x64"
    Copy-Item -LiteralPath (Join-Path $unpackedNode 'node.exe') -Destination (Join-Path $nodeDir 'node.exe')
    Assert-Hash (Join-Path $nodeDir 'node.exe') $nodeHash
    Copy-Item -LiteralPath (Join-Path $unpackedNode 'LICENSE') -Destination (Join-Path $nodeDir 'LICENSE')
  }
  Acquire-File (Join-Path $root 'cloudflared\cloudflared.exe') `
    "https://github.com/cloudflare/cloudflared/releases/download/$cloudflaredVersion/cloudflared-windows-amd64.exe" `
    (Join-Path $cloudDir 'cloudflared.exe') $cloudflaredHash
  Acquire-License (Join-Path $root 'cloudflared\LICENSE') `
    "https://raw.githubusercontent.com/cloudflare/cloudflared/$cloudflaredVersion/LICENSE" `
    (Join-Path $cloudDir 'LICENSE')

  $nsisZip = Join-Path $work "nsis-$nsisVersion.zip"
  Acquire-File '' "https://github.com/tauri-apps/binary-releases/releases/download/nsis-$nsisVersion/nsis-$nsisVersion.zip" $nsisZip $nsisHash
  $nsisDir = Join-Path $work 'nsis'
  Expand-Archive -LiteralPath $nsisZip -DestinationPath $nsisDir
  $makensis = Get-ChildItem -LiteralPath $nsisDir -Filter 'makensis.exe' -Recurse -File | Select-Object -First 1 -ExpandProperty FullName
  if (-not $makensis) { throw 'NSIS compiler was not found in the verified archive' }

  $uninstallInclude = Join-Path $work 'uninstall-files.nsh'
  $files = Get-ChildItem -LiteralPath $payload -File -Recurse | Sort-Object FullName
  $dirs = $files | ForEach-Object { Split-Path -Parent $_.FullName } | Sort-Object -Unique
  $lines = @()
  foreach ($file in $files) {
    $relative = $file.FullName.Substring($payload.Length + 1)
    if ($relative -match '[\$\"]') { throw "Unsupported payload filename: $relative" }
    $lines += "  Delete `"`$INSTDIR\$relative`""
  }
  foreach ($dir in ($dirs | Sort-Object Length -Descending)) {
    if ($dir -eq $payload) { continue }
    $relative = $dir.Substring($payload.Length + 1)
    if ($relative) { $lines += "  RMDir `"`$INSTDIR\$relative`"" }
  }
  [IO.File]::WriteAllLines($uninstallInclude, $lines, (New-Object System.Text.UTF8Encoding($true)))

  New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
  $setup = Join-Path $OutDir "PocketBridge-$version-win-x64-Setup.exe"
  & $makensis "/DPRODUCT_VERSION=$version" "/DNUMERIC_VERSION=$numericVersion" "/DPAYLOAD_DIR=$payload" `
    "/DOUTPUT_FILE=$setup" "/DUNINSTALL_INCLUDE=$uninstallInclude" `
    (Join-Path $PSScriptRoot 'installer.nsi')
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $setup)) {
    throw "NSIS failed to build $setup"
  }
  Write-Host "Built $setup"

  if (-not $SkipInstallTest) {
    $testInstall = Join-Path $work 'installed'
    New-Item -ItemType Directory -Path $testInstall | Out-Null
    [IO.File]::WriteAllText((Join-Path $testInstall 'installer-test.flag'), 'temporary installer smoke test')
    $install = Start-Process -FilePath $setup -ArgumentList @('/S', "/D=$testInstall") -WindowStyle Hidden -Wait -PassThru
    if ($install.ExitCode -ne 0) { throw "Silent install failed: $($install.ExitCode)" }
    $installedNode = Join-Path $testInstall "runtime\node-v$nodeVersion-win-x64\node.exe"
    if (-not (Test-Path -LiteralPath $installedNode)) { throw 'Installed Node is missing' }
    & $installedNode --version
    if ($LASTEXITCODE -ne 0) { throw 'Installed Node failed to launch' }
    foreach ($relative in @(
      'README.md', 'THIRD-PARTY-NOTICES.md', 'scripts\pair-code.js',
      'scripts\install-autostart.js', 'desktop\icons\app.ico',
      'desktop\icons\green.ico', 'pwa\icon-192.png',
      'scripts\desktop-ui-action.js', 'scripts\codex-desktop-driver.js',
      'scripts\codex-desktop-ui.ps1', 'scripts\codex-desktop-relay.js',
      'scripts\codex-desktop-target.js', 'scripts\codex-desktop-text.js',
      'scripts\codex-desktop-source-guard.ps1',
      'scripts\dot-desktop-driver.js', 'scripts\dot-desktop-ui.ps1', 'scripts\dot-desktop-service.js',
      'scripts\dot-desktop-protocol.js', 'scripts\dot-desktop-owner.js', 'scripts\dot-desktop-journal.js',
      'scripts\dot-desktop-private-store.js', 'scripts\dot-desktop-runtime.js',
      'scripts\dot-desktop-send-driver.js', 'scripts\dot-desktop-send.ps1',
      'scripts\dot-desktop-source-guard.ps1', 'scripts\dot-desktop-navigation-guard.ps1',
      'pwa\codex.html', 'pwa\dot.html', 'pwa\e2ee.js'
    )) {
      $sourceFile = Join-Path $root $relative
      $installedFile = Join-Path $testInstall $relative
      if (-not (Test-Path -LiteralPath $installedFile -PathType Leaf)) {
        throw "Installed payload is missing $relative"
      }
      if ((Get-FileHash -LiteralPath $sourceFile -Algorithm SHA256).Hash -ne
          (Get-FileHash -LiteralPath $installedFile -Algorithm SHA256).Hash) {
        throw "Installed payload differs from source: $relative"
      }
    }
    foreach ($private in @('config.json', 'logs\access-key.txt', 'logs\mint-cookie.json', 'uploads', 'tls')) {
      if (Test-Path -LiteralPath (Join-Path $testInstall $private)) {
        throw "Private data unexpectedly present in clean install: $private"
      }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $testInstall 'scripts\first-run.js'))) {
      throw 'Fresh install is missing first-run.js'
    }
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $testPort = $listener.LocalEndpoint.Port
    $listener.Stop()
    $savedGatewayPort = $env:DSH_GW_PORT
    $savedCredentials = $env:DSH_CREDENTIALS_FILE
    $env:DSH_GW_PORT = [string]$testPort
    $env:DSH_CREDENTIALS_FILE = Join-Path $work 'no-dsh-credentials.yaml'
    $gateway = $null
    try {
      $gateway = Start-Process -FilePath $installedNode -ArgumentList 'scripts\mobile-proxy.js' `
        -WorkingDirectory $testInstall -WindowStyle Hidden -PassThru
      $healthy = $false
      for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Milliseconds 100
        if ($gateway.HasExited) { break }
        try {
          $status = Invoke-RestMethod -Uri "http://127.0.0.1:$testPort/__health" -TimeoutSec 1
          if ($status.service -eq 'pocket-bridge-gateway') { $healthy = $true; break }
        } catch { }
      }
      if (-not $healthy) { throw 'Fresh Codex-only gateway did not become healthy' }
    } finally {
      if ($gateway -and -not $gateway.HasExited) {
        Stop-Process -Id $gateway.Id -Force
        $gateway.WaitForExit(3000) | Out-Null
      }
      $env:DSH_GW_PORT = $savedGatewayPort
      $env:DSH_CREDENTIALS_FILE = $savedCredentials
    }
    $testLog = Join-Path $testInstall 'logs'
    $testUploads = Join-Path $testInstall 'uploads'
    $accessFile = Join-Path $testLog 'access-key.txt'
    $e2eeFile = Join-Path $testLog 'e2ee-secret.txt'
    if (-not (Test-Path -LiteralPath $accessFile) -or -not (Test-Path -LiteralPath $e2eeFile)) {
      throw 'Fresh start did not create both local secrets'
    }
    if (Test-Path -LiteralPath (Join-Path $testLog 'mint-cookie.json')) {
      throw 'Codex-only fresh start unexpectedly minted a DSH cookie'
    }
    $originalAccess = Get-Content -LiteralPath $accessFile -Raw
    $originalE2ee = Get-Content -LiteralPath $e2eeFile -Raw
    New-Item -ItemType Directory -Path $testUploads | Out-Null
    [IO.File]::WriteAllText((Join-Path $testInstall 'config.json'), '{"test":"preserve"}')
    [IO.File]::WriteAllText((Join-Path $testUploads 'keep.txt'), 'sentinel-upload')
    $upgrade = Start-Process -FilePath $setup -ArgumentList @('/S', "/D=$testInstall") -WindowStyle Hidden -Wait -PassThru
    if ($upgrade.ExitCode -ne 0) { throw "Silent upgrade failed: $($upgrade.ExitCode)" }
    if ((Get-Content -LiteralPath (Join-Path $testInstall 'config.json') -Raw) -ne '{"test":"preserve"}') { throw 'Upgrade changed config.json' }
    if ((Get-Content -LiteralPath $accessFile -Raw) -ne $originalAccess) { throw 'Upgrade changed access key' }
    if ((Get-Content -LiteralPath $e2eeFile -Raw) -ne $originalE2ee) { throw 'Upgrade changed E2EE key' }
    if ((Get-Content -LiteralPath (Join-Path $testUploads 'keep.txt') -Raw) -ne 'sentinel-upload') { throw 'Upgrade changed uploads' }
    $uninstaller = Join-Path $testInstall 'Uninstall Pocket Bridge.exe'
    $uninstall = Start-Process -FilePath $uninstaller -ArgumentList '/S' -WindowStyle Hidden -Wait -PassThru
    if ($uninstall.ExitCode -ne 0) { throw "Silent uninstall failed: $($uninstall.ExitCode)" }
    if (Test-Path -LiteralPath $installedNode) { throw 'Uninstall did not remove program files' }
    foreach ($private in @('config.json', 'logs\access-key.txt', 'logs\e2ee-secret.txt', 'uploads\keep.txt')) {
      if (-not (Test-Path -LiteralPath (Join-Path $testInstall $private))) {
        throw "Uninstall removed user data: $private"
      }
    }
    Write-Host 'Fresh Codex-only gateway, install, upgrade, uninstall and user-data preservation tests passed'
  }
  Write-Host "SHA256 $((Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash)"
} finally {
  $safePrefix = $tempBase.TrimEnd('\') + '\pocket-bridge-win-build-'
  if ($work.StartsWith($safePrefix, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $work)) {
    Remove-Item -LiteralPath $work -Recurse -Force
  }
}
