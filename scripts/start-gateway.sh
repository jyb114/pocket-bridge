#!/usr/bin/env bash
# =============================================================================
# DSH 移动端网关 — macOS / Linux 启动入口
#
# 与 Windows 的 start-gateway.bat 等价：只负责找到 Node 运行时，
# 真正的逻辑都在 gateway-daemon.js 里，三个平台共用。
#
# 用法：
#   ./start-gateway.sh             正常启动
#   ./start-gateway.sh --status    只报告状态，不启动任何东西
#
# 可重复执行 —— 已经在跑的服务会跳过。
# =============================================================================

set -uo pipefail

BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# 优先用打包进来的独立 Node（不依赖系统装没装 Node）
NODE_EXE=""
for d in "$BASE"/runtime/node-*/; do
  # bin/node 是 Unix 发行版的布局；裸 node / node.exe 是 Windows 布局 ——
  # 后者是为了让 Git Bash / Cygwin 下也能跑同一份脚本，方便在 Windows 上验证。
  for cand in "${d}bin/node" "${d}node" "${d}node.exe" "${d}bin/node.exe"; do
    if [ -x "$cand" ]; then
      NODE_EXE="$cand"
      break 2
    fi
  done
done

# 退而求其次：系统 PATH 里的 node
if [ -z "$NODE_EXE" ] && command -v node >/dev/null 2>&1; then
  NODE_EXE="$(command -v node)"
fi

if [ -z "$NODE_EXE" ]; then
  echo "[DSH 网关] 找不到 Node 运行时。" >&2
  echo "           请确认 $BASE/runtime/ 目录完整，或安装 Node.js。" >&2
  exit 1
fi

exec "$NODE_EXE" "$BASE/scripts/gateway-daemon.js" "$@"
