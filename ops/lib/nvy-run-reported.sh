#!/usr/bin/env bash
# nvy-run-reported.sh — 通用「跑命令 → 跑完推飞书 report」wrapper（runitor 范式自建）。
#
# 把任意定时命令包一层：捕获退出码 + stdout/stderr 末尾，组装「机器 + 任务 + 状态 + 耗时 + 结果」
# 推飞书。各定时脚本本就把汇总数字打在 stdout → **数字白捡、脚本零业务改动**；飞书传输全归这里。
# 同时写一条心跳（成功 / 失败都写 = 「我执行过」），供 nvy-watchdog 检 no-show（任务根本没跑）。
#
# 用法：
#   nvy-run-reported <task-label> [--on-success report|silent] [--tail N] -- <cmd> [args...]
#     --on-success report  （默认）成功也推 report —— 每日批任务用
#     --on-success silent          成功不推、仅失败推 —— 高频任务预留（本仓高频族暂不走 wrapper）
#     --tail N             结果取合并输出末 N 行（默认 20）
#
# 透传 <cmd> 的真实退出码（PIPESTATUS）；输出仍实时进 launchd.log / journal（tee）。
# 发送复用同目录（或候选路径）的 feishu-send.sh —— 自包含副本下同目录优先，仓内运行退回 ops/lib。
set -uo pipefail

# ── 候选路径 source feishu-send.sh（同目录＝ ~/.nvy 自包含副本 / /usr/local/lib/nvy；退回仓内）──
_self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for _c in "$_self_dir/feishu-send.sh" \
          "$_self_dir/../ops/lib/feishu-send.sh" \
          "$_self_dir/../../ops/lib/feishu-send.sh"; do
  [ -f "$_c" ] && { . "$_c"; break; }
done

# ── 解析参数 ─────────────────────────────────────────────────────────────────────
TASK=""; ON_SUCCESS="report"; TAIL_N="20"
while [ $# -gt 0 ]; do
  case "$1" in
    --on-success) ON_SUCCESS="$2"; shift 2 ;;
    --tail) TAIL_N="$2"; shift 2 ;;
    --) shift; break ;;
    -*) echo "[nvy-run-reported] 未知参数：$1" >&2; exit 2 ;;
    *) if [ -z "$TASK" ]; then TASK="$1"; shift; else echo "[nvy-run-reported] 多余参数：$1" >&2; exit 2; fi ;;
  esac
done
[ -n "$TASK" ] || { echo "[nvy-run-reported] 缺 <task-label>" >&2; exit 2; }
[ $# -gt 0 ] || { echo "[nvy-run-reported] 缺 -- <cmd>" >&2; exit 2; }

MACHINE="${NVY_MACHINE:-$(hostname)}"
# systemd 系统服务不设 $HOME，set -u 下裸 $HOME 会 unbound 崩溃 → ${HOME:-/var/lib/nvy} 兜底。
# 显式 NVY_HEARTBEAT_DIR（prod systemd 经 /etc/nvy-alert.env 注入 /var/lib/nvy/heartbeats）优先。
HEARTBEAT_DIR="${NVY_HEARTBEAT_DIR:-${HOME:-/var/lib/nvy}/.nvy/heartbeats}"
beijing_now() { TZ=Asia/Shanghai date '+%Y-%m-%d %H:%M:%S %z'; }

# ── 跑命令：2>&1 合并后 tee（实时透传 launchd.log/journal + 抓全量入 buf）；PIPESTATUS 保真退出码 ──
buf="$(mktemp "${TMPDIR:-/tmp}/nvy-run.XXXXXX")"
trap 'rm -f "$buf"' EXIT
start=$(date +%s)
"$@" 2>&1 | tee "$buf"
rc=${PIPESTATUS[0]}
dur=$(( $(date +%s) - start ))

# ── 写心跳（成功 / 失败都写 = 「本次执行过」；mtime 为准，内容存 epoch 便于排查）──────────────
mkdir -p "$HEARTBEAT_DIR" 2>/dev/null || true
printf '%s\n' "$(date +%s)" > "$HEARTBEAT_DIR/$TASK.beat" 2>/dev/null || true

# ── 成功且 silent → 不推（仅写了心跳，留给每日摘要 / 看门狗）─────────────────────────────
if [ "$rc" -eq 0 ] && [ "$ON_SUCCESS" = "silent" ]; then
  exit 0
fi

if [ "$rc" -eq 0 ]; then head="✅ 定时任务报告"; else head="🔴 定时任务告警"; fi
tail_txt="$(tail -n "$TAIL_N" "$buf")"
msg="$(printf '%s\n机器: %s\n任务: %s\n耗时: %ss\n时间: %s\n结果:\n%s' \
  "$head" "$MACHINE" "$TASK" "$dur" "$(beijing_now)" "$tail_txt")"

command -v feishu_send >/dev/null 2>&1 \
  && feishu_send "$msg" \
  || echo "[nvy-run-reported] feishu-send.sh 未载入，跳过推送（仅本地输出）" >&2

exit "$rc"
