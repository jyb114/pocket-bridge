#!/usr/bin/env bash
# =============================================================================
# DSH 移动端网关 — 打开电脑端控制台
#
# 双击或在终端里运行都可以：它会确保服务在跑，然后打开控制台页面。
# =============================================================================

set -uo pipefail

BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

NODE_EXE=""
for d in "$BASE"/runtime/node-*/; do
  for cand in "${d}bin/node" "${d}node" "${d}node.exe" "${d}bin/node.exe"; do
    if [ -x "$cand" ]; then
      NODE_EXE="$cand"
      break 2
    fi
  done
done
if [ -z "$NODE_EXE" ] && command -v node >/dev/null 2>&1; then
  NODE_EXE="$(command -v node)"
fi

if [ -z "$NODE_EXE" ]; then
  echo "[DSH 网关] 找不到 Node 运行时。" >&2
  echo "           请确认 $BASE/runtime/ 目录完整，或安装 Node.js。" >&2
  exit 1
fi

exec "$NODE_EXE" "$BASE/scripts/open-console.js"
