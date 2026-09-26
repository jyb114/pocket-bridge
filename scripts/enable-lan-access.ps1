# =============================================================================
# PocketBridge 网关 — 放行内网访问（需要管理员）
#
# 作用：允许同一 WiFi 下的手机直接访问电脑的 8080 端口，从而不必走
#       Cloudflare 隧道 —— 不需要 VPN、延迟低、也不依赖外网。
#
# 安全说明：
#   只放行「专用网络」配置文件（家里的 WiFi）。在公共 WiFi（机场、咖啡店）
#   下这条规则不生效，避免把开发环境暴露给陌生人。
#   访问仍然需要访问密钥，没有密钥的人会收到 403。
#
# 如果你之后想撤销，运行 revoke-lan-access.ps1。
# =============================================================================

#Requires -RunAsAdministrator

$ErrorActionPreference = 'Stop'

$RuleName = 'PocketBridge Gateway (LAN 8080)'

# 项目改过名（原 DSH Mobile Gateway）。装过旧版本的机器上可能残留旧规则，
# 不清掉的话会出现「两条规则同时管 8080」，将来想撤销时容易漏掉一条。
$LegacyRuleNames = @(
    'DSH Mobile Gateway (LAN 8080)',
    'DSH Mobile Gateway (Caddy, TCP 80/443)',
    'DSH Mobile Gateway (Caddy, HTTP/3 UDP 443)'
)

$LogDir   = Join-Path (Split-Path -Parent $PSScriptRoot) 'logs'
$LogFile  = Join-Path $LogDir 'lan-firewall-run.log'

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
Start-Transcript -Path $LogFile -Force | Out-Null

try {
    Write-Host "时间: $(Get-Date -Format o)"

    Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue |
        Remove-NetFirewallRule -ErrorAction SilentlyContinue

    # 清理历史遗留（含已废弃的 Caddy 方案）
    foreach ($legacy in $LegacyRuleNames) {
        $old = Get-NetFirewallRule -DisplayName $legacy -ErrorAction SilentlyContinue
        if ($old) {
            Remove-NetFirewallRule -DisplayName $legacy -ErrorAction SilentlyContinue
            Write-Host "已清理历史规则: $legacy"
        }
    }

    New-NetFirewallRule `
        -DisplayName $RuleName `
        -Direction   Inbound `
        -Action      Allow `
        -Protocol    TCP `
        -LocalPort   8080 `
        -Profile     Private | Out-Null

    Write-Host "已添加规则: $RuleName（仅专用网络）"
    Write-Host ''
    Get-NetFirewallRule -DisplayName $RuleName |
        Select-Object DisplayName, Enabled, Direction, Action, Profile |
        Format-Table -AutoSize

    Write-Host 'RESULT: OK'
}
catch {
    Write-Host "RESULT: FAILED - $($_.Exception.Message)"
    throw
}
finally {
    Stop-Transcript | Out-Null
}
