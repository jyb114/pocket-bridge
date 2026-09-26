# =============================================================================
# DSH 移动端网关 — hook 通知转发
#
# 由 DSH 的 Stop hook 在「一轮干完、等你发话」时调用。
# 它只做一件事：把通知交给本地中间层（纯 HTTP、无 TLS、无凭据），
# 由常驻的中间层去推 Bark / ntfy。这样换推送通道不用改 DSH 配置。
#
# 关键：最后必须 exit 0。
#   hook 协议里退出码 2 表示「阻塞并让模型继续跑一步」，非零其它值算失败。
#   我们只是报个信，绝不能干扰 agent 的运行。
# =============================================================================

$ErrorActionPreference = 'Continue'

# hook 会通过 stdin 传一段 JSON（含 session_id、cwd 等）。读不到也不影响。
$raw = ''
try { $raw = [Console]::In.ReadToEnd() } catch { }

$cwd = ''
$sessionId = ''
try {
    $p = $raw | ConvertFrom-Json
    if ($p.cwd) { $cwd = [string]$p.cwd }
    if ($p.session_id) { $sessionId = [string]$p.session_id }
} catch { }

$title = 'DSH 任务完成'
if ($cwd) {
    $leaf = Split-Path -Leaf $cwd
    if ($leaf) { $body = "$leaf 上的活干完了" } else { $body = $cwd }
} else {
    $body = '电脑上的活干完了，回来看看。'
}

$t = [uri]::EscapeDataString($title)
$b = [uri]::EscapeDataString($body)

try {
    Invoke-RestMethod -Uri "http://127.0.0.1:8080/__notify?title=$t&body=$b" -TimeoutSec 15 | Out-Null
} catch {
    # 中间层没跑就算了，绝不能因此让 agent 出错
}

exit 0
