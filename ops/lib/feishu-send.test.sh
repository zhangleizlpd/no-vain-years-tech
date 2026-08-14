#!/usr/bin/env bash
#
# feishu-send.test.sh — `_nvy_json_escape` 的回归测试（**不发送任何消息**）。
#
# 存在理由：2026-08-15 一条「健康探测失败」告警凭空消失。根因是被包命令的 stderr 带 ANSI 颜色，
# 裸 0x1B 穿过转义进了 JSON → 非法 JSON → 飞书拒收 → `curl -fsS ... || true` 静默吞掉。
# 失败面很宽（`nvy-run-reported.sh` 会把任意命令输出塞进消息），且**完全无痕迹** ⇒ 值得一个测试钉住。
#
# 跑：bash ops/lib/feishu-send.test.sh
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$DIR/feishu-send.sh"

command -v python3 >/dev/null 2>&1 || { echo 'SKIP: 需要 python3 做 JSON 合法性判定'; exit 0; }

pass=0; fail=0
check() {  # check <name> <input>
  local name="$1" input="$2" esc
  esc="$(printf '%s' "$input" | _nvy_json_escape)"
  if python3 -c '
import json,sys
try:
    v = json.loads("{\"t\":\"%s\"}" % sys.argv[1])["t"]
except Exception as e:
    print(f"  JSON 非法: {e}"); sys.exit(1)
# \t 与 \n 是**合法且有意**保留的（JSON 里以 \t / \n 转义形式传输，解回来就是 0x09 / 0x0A）。
# 其余 C0 控制字符与 DEL 必须已被剔除 —— 它们进 JSON 就是非法，是本测试要钉住的东西。
bad = [c for c in v if (ord(c) < 0x20 and c not in "\t\n") or ord(c) == 0x7F]
if bad:
    print(f"  解出的字符串仍含非法控制字符: {[hex(ord(c)) for c in bad]}"); sys.exit(1)
sys.exit(0)
' "$esc"; then
    printf '  ✅ %s\n' "$name"; pass=$((pass+1))
  else
    printf '  🔴 %s\n     esc=%q\n' "$name" "$esc"; fail=$((fail+1))
  fi
}

echo '=== _nvy_json_escape 回归 ==='
check '纯 ASCII'                 'hello world'
check '中文 + 全角标点'           '任务失败（原因：盘满）'
check '双引号与反斜杠'            'path C:\Windows "quoted"'
check '制表符'                    "$(printf 'a\tb')"
check 'CR 混入'                   "$(printf 'a\r\nb')"
check '多行'                      "$(printf 'line1\nline2\nline3')"
check '🚨 ANSI 红色（真实回归）'   "$(printf 'ERR \033[1;31mSDK.ServerError\033[0m tail')"
check '🚨 裸 ESC 无完整序列'       "$(printf 'a\033b')"
check '🚨 其它 C0 控制字符'        "$(printf 'a\001b\013c\016d')"
check '🚨 DEL (0x7F)'             "$(printf 'a\177b')"
check 'emoji（应原样保留，非控制字符）' '🔴 告警 ✅ 恢复'

# ANSI 必须整段消失，不能只删 ESC 留下 [1;31m
ansi_out="$(printf 'X\033[1;31mY\033[0mZ' | _nvy_json_escape)"
if [ "$ansi_out" = 'XYZ' ]; then
  printf '  ✅ ANSI 整段剔除（得到 %s）\n' "$ansi_out"; pass=$((pass+1))
else
  printf '  🔴 ANSI 未整段剔除：期望 XYZ，实得 %q\n' "$ansi_out"; fail=$((fail+1))
fi

printf '\n通过 %s · 失败 %s\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
