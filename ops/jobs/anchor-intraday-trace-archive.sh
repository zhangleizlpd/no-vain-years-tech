#!/usr/bin/env bash
#
# anchor-intraday-trace-archive（77）—— 把 app 容器 stdout 里**会被环覆盖掉**的那部分留痕
# 落到盘上，让「昨天哪几轮盘中采集失败了」在明天仍然查得出来。
#
# ## 为什么需要它（issue #98）
#
# 061 `SC-006` 要求「失败轮次可从留痕中逐条查出」，而 `sync-anchor-intraday.scheduler.ts` 的
# 失败留痕**只有 `logger.warn` 一条路，只进容器 stdout**（Redis 的 failstreak 下一次成功即清 0、
# circuit 只有当下状态、`anchor.updateMany` 蓄意不入痕迹表）。
# prod app 容器日志是 `json-file` `10m × 3` = 30 MB 环，实测约 2.25 MB/h ⇒ **约 13 小时就转没**。
# ⇒ 今天的失败轮次，明天下午就查无实据。本任务补的就是这个载体（#98 的「路 2」）。
#
# ## 过滤口径：**排除噪音**，不是**只留关键字**
#
# 2026-08-19 在 44.9 MB 真实 prod 日志镜像上实测：
#
#   总行数 68188 ── agent-queue 63771 行（93.5%）── 其余 4417 行
#   字节   44.9 MB ────────────────────────────────→ 去掉 agent-queue 后 1.2 MB（**2.7%**）
#   同一窗口里 `SyncAnchorIntradayScheduler` 只出现 **9 行**
#
# 体积主因是 `/api/v1/agent-queue/poll` 每秒一条 access log，**不是** scheduler。
#
# 🚨 因此本脚本**只剔掉这一个已知噪音源，其余全留**。反过来做（只 grep
# `SyncAnchorIntradayScheduler`）看似更省，实则有两个致命面：
#   ① 只剩 9 行，失败**前后的上下文**（谁先超时、哪个依赖先抖）全丢 —— 而事后归因要的正是它；
#   ② scheduler 改个 logger 名 / 换个报错路径，过滤器**静默失明**，而日志文件还在长，
#      看起来一切正常。
# 判据：「如果反例存在，这条管道看得见吗？」剔噪音 → 看得见；留关键字 → 看不见。
#
# ## 落点与保留
#
#   /var/lib/nvy/anchor-intraday-trace/<YYYY-MM>.log   按月追加（含 docker 时间戳）
#   /var/lib/nvy/anchor-intraday-trace/.since          断点（上次归档到的最后一条时间戳）
#
# 按上面实测量估：约 1.5 MB/天 ⇒ 默认保留 90 天约 135 MB。
#
# 调参（可选，经 /etc/anchor-intraday-trace-archive.env）：
#   ANCHOR_TRACE_CONTAINER   默认 nvy-tight-app-1（compose 项目 nvy-tight × 服务 app）
#   ANCHOR_TRACE_DIR         默认 /var/lib/nvy/anchor-intraday-trace
#   ANCHOR_TRACE_RETAIN_DAYS 默认 90
#   ANCHOR_TRACE_NOISE_RE    默认 agent-queue（要再剔别的噪音源时改这里，别去改代码）
#
# 退出码：0 归档完成（含「本次零新增」）| 2 环境不对（无 docker / 容器不在）| 3 归档写入失败
set -euo pipefail
set -o pipefail

CONTAINER="${ANCHOR_TRACE_CONTAINER:-nvy-tight-app-1}"
DIR="${ANCHOR_TRACE_DIR:-/var/lib/nvy/anchor-intraday-trace}"
RETAIN_DAYS="${ANCHOR_TRACE_RETAIN_DAYS:-90}"
NOISE_RE="${ANCHOR_TRACE_NOISE_RE:-agent-queue}"

SINCE_FILE="$DIR/.since"
# 首跑没有断点时回看 24h —— 环里本来也只有约 13h，多要的部分 docker 直接给不出来，无害。
FIRST_RUN_LOOKBACK="24h"

command -v docker >/dev/null 2>&1 || { echo "docker 不可用" >&2; exit 2; }
docker inspect "$CONTAINER" >/dev/null 2>&1 || { echo "容器不存在: ${CONTAINER}" >&2; exit 2; }

mkdir -p "$DIR" || { echo "建目录失败: ${DIR}" >&2; exit 3; }

if [[ -s "$SINCE_FILE" ]]; then
  SINCE="$(cat "$SINCE_FILE")"
else
  SINCE=""
fi

RAW="$(mktemp)"
trap 'rm -f "$RAW"' EXIT

# --timestamps 让每行带 RFC3339Nano(UTC, 固定 9 位小数) 前缀 —— 它同时是断点游标。
# docker logs 失败不该被 pipefail 之外的东西吞掉，故先落文件再处理。
if [[ -n "$SINCE" ]]; then
  docker logs --timestamps --since "$SINCE" "$CONTAINER" > "$RAW" 2>&1 || {
    echo "docker logs 失败 (since=${SINCE})" >&2; exit 3; }
else
  docker logs --timestamps --since "$FIRST_RUN_LOOKBACK" "$CONTAINER" > "$RAW" 2>&1 || {
    echo "docker logs 失败 (首跑 lookback=${FIRST_RUN_LOOKBACK})" >&2; exit 3; }
fi

TOTAL="$(wc -l < "$RAW" | tr -d ' ')"

# ① 丢掉 <= 断点的行。`--since` 是**闭区间**,不去重会让断点那一行每轮重复落盘。
#    时间戳是定宽 RFC3339Nano + Z,故字符串比较即时间比较。
# ② 剔噪音。
KEPT_FILE="$(mktemp)"
trap 'rm -f "$RAW" "$KEPT_FILE"' EXIT
awk -v since="$SINCE" -v noise="$NOISE_RE" '
  { ts = $1 }
  since != "" && ts <= since { next }
  $0 ~ noise { next }
  { print }
' "$RAW" > "$KEPT_FILE"

KEPT="$(wc -l < "$KEPT_FILE" | tr -d ' ')"

if [[ "$KEPT" -gt 0 ]]; then
  MONTH="$(date -u '+%Y-%m')"
  cat "$KEPT_FILE" >> "$DIR/$MONTH.log" || { echo "追加归档失败: ${DIR}/${MONTH}.log" >&2; exit 3; }
fi

# 断点推进到**本轮原始输出**的最后一行时间戳（不是过滤后的）——
# 否则一段全是噪音的窗口会让断点原地不动,下一轮把同一段重新拉一遍。
if [[ "$TOTAL" -gt 0 ]]; then
  LAST_TS="$(awk 'END { print $1 }' "$RAW")"
  if [[ -n "$LAST_TS" ]]; then
    printf '%s' "$LAST_TS" > "$SINCE_FILE" || { echo "断点写入失败: ${SINCE_FILE}" >&2; exit 3; }
  fi
fi

# 保留期裁剪。按月成文件,故删的粒度也是月。
PRUNED="$(find "$DIR" -maxdepth 1 -name '*.log' -type f -mtime "+${RETAIN_DAYS}" -print -delete 2>/dev/null | wc -l | tr -d ' ')"

DISK="$(du -sh "$DIR" 2>/dev/null | awk '{ print $1 }')"
echo "✅ anchor-intraday-trace: 读 ${TOTAL} 行 → 归档 ${KEPT} 行 (剔噪 ${NOISE_RE}) · 裁剪 ${PRUNED} 个月文件 · 现占 ${DISK:-?}"
