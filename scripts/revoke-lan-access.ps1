# =============================================================================
# PocketBridge 网关 — 撤销内网访问放行（需要管理员）
# =============================================================================

#Requires -RunAsAdministrator

$ErrorActionPreference = 'Continue'

# 项目改过名（原 DSH Mobile Gateway）。这里把新旧名字都列上：
# 只认新名字的话，改名之前装过的机器上，这条规则会撤不掉 ——
# 使用者以为关掉了内网放行，实际上 8080 还开着。那是最糟的情况。
$RuleNames = @(
    'PocketBridge Gateway (LAN 8080)',
    'DSH Mobile Gateway (LAN 8080)'
)

# 顺带清掉早期 Caddy 方案留下的规则（那套方案已废弃删除了）
$ObsoleteNames = @(
    'DSH Mobile Gateway (Caddy, TCP 80/443)',
    'DSH Mobile Gateway (Caddy, HTTP/3 UDP 443)'
)

$removed = 0
foreach ($name in ($RuleNames + $ObsoleteNames)) {
    $found = Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue
    if ($found) {
        Remove-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue
        Write-Host "  已移除: $name"
        $removed++
    }
}

if ($removed -eq 0) {
    Write-Host '没有找到放行规则，无需清理。'
} else {
    Write-Host "共移除 $removed 条规则。"
}
exit 0
