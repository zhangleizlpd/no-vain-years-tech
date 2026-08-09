#!/usr/bin/env bash
# nvy-watchdog.sh — no-show 看门狗：查每日任务过去 ~25h 有没有「上报过」（心跳），没报就告警。
#
# 补 in-job report 的盲区：任务**根本没跑**（Mac 睡死 / timer 被禁 / plist 丢）时无任何推送 →
# 静默 = 误以为正常。看门狗每日跑一次，比对 nvy-run-reported 写的心跳 mtime，过期 / 缺失则推飞书。
#
# 用法：nvy-watchdog "<task>:<max-age-sec> <task2>:<max-age-sec> ..."
#   （或经 env `NVY_WATCHDOG_TASKS` 传同格式清单。）省略 :sec 时按缺省 90000s（25h，日任务留 1h 余量）。
#
# 局限：本机看门狗逃不出「整机宕 / 全程睡死」—— 那种唯有**外部**监控（healthchecks 之类）能兜，
#       单人 3 机暂不上（见 ops/runbook/scheduled-tasks.md）。
set -uo pipefail

SPEC="${1:-${NVY_WATCHDOG_TASKS:-}}"
[ -n "$SPEC" ] || { echo "[nvy-watchdog] 缺任务清单 \"<task>:<sec> ...\"（或 env NVY_WATCHDOG_TASKS）" >&2; exit 2; }

# 候选路径 source feishu-send.sh（同目录优先；退回仓内 ops/lib）
_self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for _c in "$_self_dir/feishu-send.sh" \
          "$_self_dir/../ops/lib/feishu-send.sh" \
          "$_self_dir/../../ops/lib/feishu-send.sh"; do
  [ -f "$_c" ] && { . "$_c"; break; }
done

MACHINE="${NVY_MACHINE:-$(hostname)}"
# systemd 系统服务不设 $HOME，set -u 下裸 $HOME 会 unbound 崩溃 → ${HOME:-/var/lib/nvy} 兜底。
# 须与 nvy-run-reported.sh 写心跳的目录一致（同机同 HOME 状态 → 同路径；prod 经 env 注入显式路径）。
HEARTBEAT_DIR="${NVY_HEARTBEAT_DIR:-${HOME:-/var/lib/nvy}/.nvy/heartbeats}"
DEFAULT_MAX=90000
now=$(date +%s)
stale=""

mtime_of() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0; }

# SPEC 为空格分隔（bash word-split 故意为之）；逐 task 比对心跳新鲜度
for item in $SPEC; do
  task="${item%%:*}"
  max="${item#*:}"; { [ "$max" = "$item" ] || [ -z "$max" ]; } && max="$DEFAULT_MAX"
  beat="$HEARTBEAT_DIR/$task.beat"
  if [ ! -f "$beat" ]; then
    stale="${stale}- ${task}：从无心跳（${beat} 不存在 → 可能从未成功跑过）\n"
    continue
  fi
  age=$(( now - $(mtime_of "$beat") ))
  if [ "$age" -ge "$max" ]; then
    stale="${stale}- ${task}：已 $(( age / 3600 ))h 未上报（阈值 $(( max / 3600 ))h）\n"
  fi
done

if [ -z "$stale" ]; then
  echo "✅ 看门狗：所有任务心跳新鲜（${MACHINE}）"
  exit 0
fi

# 文案含「定时任务告警」—— 与 wrapper 同 header 族，签名校验下无关键词约束
msg="$(printf '🔴 定时任务告警（看门狗）\n机器: %s\n以下任务超时未上报 —— 可能根本没跑（timer 被禁 / 机器睡死 / plist 丢）：\n%b' "$MACHINE" "$stale")"
printf '%s\n' "$msg" >&2
command -v feishu_send >/dev/null 2>&1 && feishu_send "$msg"
exit 1
