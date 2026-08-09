#!/usr/bin/env bash
# daily-digest.sh — code-index 每日健康摘要（正向「活着」信号）。
#
# 高频族（tick ~2min / freshness ~5min）刻意**不每跑推飞书**（会刷屏），仅失败 / drift 才告警 →
# 平日静默时用户无从确认「它还在跑」。本脚本每日推一条正向摘要：过去 24h 索引几次提交、当前是否
# 追平 origin/main、tick timer 是否在跑。这条每日到达本身即 62 接地检索的 liveness 信号。
#
# 跑法：systemd code-index-daily-digest.timer（每日 ~09:10），WorkingDirectory=services/code-index。
# 复用 /etc/code-index.env（PG + repo）+ /etc/nvy-alert.env（NVY_ALERT_*，feishu-send.sh 用）。
set -uo pipefail

# 飞书发送原语（候选路径：仓内 ops/lib；脚本由 WorkingDirectory=services/code-index 跑）
for _c in "$(dirname "$0")/../../../ops/lib/feishu-send.sh" \
          "$(dirname "$0")/../../ops/lib/feishu-send.sh"; do
  [ -f "$_c" ] && { . "$_c"; break; }
done

MACHINE="${NVY_MACHINE:-$(hostname)}"
REPO_ROOT="${CODE_INDEX_REPO_MONO_ROOT:-/root/no-vain-years-mono}"
BRANCH="${CODE_INDEX_BRANCH:-main}"
PG_CONTAINER="${CODE_INDEX_PG_CONTAINER:-code-index-pgvector}"
PG_USER="${CODE_INDEX_PG_USER:-codeindex}"
PG_DB="${CODE_INDEX_PG_DB:-codeindex}"
PG_PASSWORD="${CODE_INDEX_PG_PASSWORD:-codeindex}"
TICK_TIMER="code-index-tick.timer"

beijing_now() { TZ=Asia/Shanghai date '+%Y-%m-%d %H:%M:%S %z'; }

# 过去 24h main 上的提交数（≈ 被增量索引的提交数；origin/main 由 tick 每 2min fetch 保新）
commits_24h="$(git -C "$REPO_ROOT" log --oneline --since='24 hours ago' "origin/${BRANCH}" 2>/dev/null | wc -l | tr -d ' ')"
[ -n "$commits_24h" ] || commits_24h='?'

# 当前追平状态：true remote tip（ls-remote）vs embedded last_sha（pgvector index_meta）
remote="$(timeout 20 git -C "$REPO_ROOT" ls-remote origin "refs/heads/${BRANCH}" 2>/dev/null | awk '{print $1}')"
last_sha="$(timeout 15 docker exec -e PGPASSWORD="$PG_PASSWORD" "$PG_CONTAINER" \
  psql -U "$PG_USER" -d "$PG_DB" -tAc "select last_sha from index_meta where repo='mono'" 2>/dev/null | tr -d '[:space:]')"
if [ -z "$remote" ] || [ -z "$last_sha" ]; then
  catchup="索引状态未知（remote / last_sha 读取失败）"
elif [ "$remote" = "$last_sha" ]; then
  catchup="已追平 origin/${BRANCH}@${remote:0:8}"
else
  catchup="落后 origin/${BRANCH}（remote=${remote:0:8} last_sha=${last_sha:0:8}）"
fi

if systemctl is-active --quiet "$TICK_TIMER"; then tick="active"; else tick="INACTIVE ⚠️"; fi

msg="$(printf '✅ 定时任务报告\n机器: %s\n任务: code-index-digest\n时间: %s\n结果:\n过去24h 索引 %s 提交；%s；tick timer %s' \
  "$MACHINE" "$(beijing_now)" "$commits_24h" "$catchup" "$tick")"

printf '%s\n' "$msg"
command -v feishu_send >/dev/null 2>&1 && feishu_send "$msg"
