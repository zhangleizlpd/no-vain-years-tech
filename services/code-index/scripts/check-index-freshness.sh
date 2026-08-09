#!/usr/bin/env bash
# check-index-freshness.sh — staleness monitor for the code-index incremental
# pipeline (mirror of ops/jobs/cert-expiry-monitor.sh, for the grounding index).
#
# The ~2min cron tick (cron-tick.sh) fetches origin/main and re-embeds changed
# files, advancing index_meta.last_sha. Several SILENT-STALL modes freeze last_sha
# while main moves on — and the tick STILL exits 0, so the timer looks healthy:
#   - query-heartbeat starvation: every tick self-skips (query > index priority)
#   - builder crash-loop / git-fetch auth failure: tick fails, but nothing alerts
#   - tick timer disabled
#   - builder HANGS after finishing: the one-shot unit stays `activating`, so the timer
#     stays `active` yet never fires again (its next elapse is relative to the end of the
#     current activation) — §5 names this one, since §4 alone reports a healthy timer
# Symptom is uniform: the EMBEDDED index falls behind origin/main and STAYS behind.
# This probes that gap directly — true remote tip (git ls-remote) vs DB last_sha;
# if they diverge for longer than the grace window, alert to the Feishu bot.
#
# Quiet periods (no new commits → last_sha == remote) are HEALTHY regardless of age,
# so we alert on DRIFT-with-grace, never on indexed_at age (old-but-fine when idle).
# Active query sessions (fresh heartbeat) legitimately stall the index per ADR-0060
# (query > index), so a fresh heartbeat SUPPRESSES the drift alert (same TTL logic as
# the tick). Also flags the tick timer being inactive (proactive — catches a dead
# timer during a quiet period, before the next commit would expose it).
#
# Exits non-zero on any problem so the systemd unit is marked failed
# (`systemctl --failed` / journalctl visible) even without a webhook configured.
#
# 高频监控（5min）保留自身 grace/去重/query-heartbeat 抑制逻辑（不套 nvy-run-reported wrapper，
# 否则 drift 期间 5min 刷屏）；仅把飞书传输换成共享 feishu-send.sh（NVY_ALERT_* 公共配置）。
#
# Config — EnvironmentFile /etc/code-index.env (reused: PG + repo + heartbeat) +
# /etc/nvy-alert.env (shared NVY_ALERT_WEBHOOK_URL / _FEISHU_SECRET, used by feishu-send.sh) +
# optional /etc/code-index-monitor.env (task tuning):
#   INDEX_STALE_WINDOW_MIN     minutes main may lead last_sha before alert (default 30).
#   INDEX_LS_REMOTE_TRIES      ls-remote 连通性探测重试次数，吸收 CN host 瞬时抖动 (default 3).
#   INDEX_ALERT_REPEAT_MIN     同一问题重复推送的最小间隔 (default 60)，见下方「告警去重」。
#   INDEX_TICK_STUCK_MIN       builder 可以合法跑多久才判「卡死」(default 150)。独立于 drift
#                              窗口：大批次几百 chunk 本就要跑 20-30min，复用 30m 窗口会误报。
#                              保持 < unit 的 TimeoutStartSec(4h)，否则永远轮不到它先说话；
#                              也必须宽于最大合法批次（~1400 chunk ≈ 90min），否则正常的
#                              全仓 sweep 会被判成挂死。io_uring 根因已在 unit 里按死
#                              (UV_USE_IO_URING=0)，这条如今只是兜底，钝一点可以接受。
#   CODE_INDEX_MONITOR_STATE   pending-SHA state file (default /var/lib/code-index/freshness.state).
#   CODE_INDEX_PG_CONTAINER    pgvector container (default code-index-pgvector).
#   (+ reuses CODE_INDEX_REPO_MONO_ROOT / CODE_INDEX_BRANCH / CODE_INDEX_PG_* /
#      CODE_INDEX_HEARTBEAT[_TTL] from /etc/code-index.env)
# NVY_ALERT_WEBHOOK_URL unset → check + log only, no push (graceful pre-config).
set -uo pipefail

# 飞书发送原语（候选路径：仓内 ops/lib；脚本由 WorkingDirectory=services/code-index 跑）
for _c in "$(dirname "$0")/../../../ops/lib/feishu-send.sh" \
          "$(dirname "$0")/../../ops/lib/feishu-send.sh"; do
  [ -f "$_c" ] && { . "$_c"; break; }
done

WINDOW_MIN="${INDEX_STALE_WINDOW_MIN:-30}"
LS_REMOTE_TRIES="${INDEX_LS_REMOTE_TRIES:-3}"
REPEAT_MIN="${INDEX_ALERT_REPEAT_MIN:-60}"
STUCK_MIN="${INDEX_TICK_STUCK_MIN:-150}"
REPO_ROOT="${CODE_INDEX_REPO_MONO_ROOT:-/root/no-vain-years-mono}"
BRANCH="${CODE_INDEX_BRANCH:-main}"
PG_CONTAINER="${CODE_INDEX_PG_CONTAINER:-code-index-pgvector}"
PG_USER="${CODE_INDEX_PG_USER:-codeindex}"
PG_DB="${CODE_INDEX_PG_DB:-codeindex}"
PG_PASSWORD="${CODE_INDEX_PG_PASSWORD:-codeindex}"
STATE_FILE="${CODE_INDEX_MONITOR_STATE:-/var/lib/code-index/freshness.state}"
ALERT_STATE="${STATE_FILE}.alert"
HEARTBEAT="${CODE_INDEX_HEARTBEAT:-/tmp/code-index-query.heartbeat}"
HEARTBEAT_TTL="${CODE_INDEX_HEARTBEAT_TTL:-120}"
TICK_TIMER="code-index-tick.timer"
TICK_SERVICE="code-index-tick.service"

now=$(date +%s)
problems=""
report=""

# --- 1. true remote tip (read-only; also validates git connectivity / deploy key) ---
# CN host → ssh.github.com:443 偶发瞬时 RST/超时；单次失败 ≠ 持续故障，故短退避重试
# 数次，全失败才判连通性问题（真·断网 / deploy key 失效仍会全失败 → 照常告警，不被掩盖）。
remote=""
for (( _try = 1; _try <= LS_REMOTE_TRIES; _try++ )); do
  remote=$(timeout 20 git -C "$REPO_ROOT" ls-remote origin "refs/heads/${BRANCH}" 2>/dev/null | awk '{print $1}')
  [ -n "$remote" ] && break
  [ "$_try" -lt "$LS_REMOTE_TRIES" ] && sleep "$(( _try * 3 ))"   # 退避 3s, 6s, …
done
if [ -z "$remote" ]; then
  problems="${problems}ls-remote origin/${BRANCH} 失败（网络 / deploy key？indexer 也无法 fetch；已重试 ${LS_REMOTE_TRIES} 次）\n"
  report="${report}remote: ❌ ls-remote 失败（重试 ${LS_REMOTE_TRIES} 次）\n"
fi

# --- 2. embedded index last_sha (from pgvector; -tAc = tuples-only, unaligned) ---
last_sha=$(timeout 15 docker exec -e PGPASSWORD="$PG_PASSWORD" "$PG_CONTAINER" \
  psql -U "$PG_USER" -d "$PG_DB" -tAc \
  "select last_sha from index_meta where repo='mono'" 2>/dev/null | tr -d '[:space:]')
if [ -z "$last_sha" ]; then
  problems="${problems}读 index_meta.last_sha 失败（pgvector 容器 ${PG_CONTAINER} 挂了 / 表缺失？）\n"
  report="${report}index: ❌ 读 last_sha 失败\n"
fi

# --- 3. drift-with-grace (only when both ends are readable) ---
if [ -n "$remote" ] && [ -n "$last_sha" ]; then
  report="${report}remote=${remote:0:8} last_sha=${last_sha:0:8}\n"
  if [ "$remote" = "$last_sha" ]; then
    report="${report}✅ 已追平 origin/${BRANCH}\n"
    # 连同去重记忆一起清 —— 恢复之后若再出问题，第一条必须立刻推，不受上次退避牵连
    rm -f "$STATE_FILE" "$ALERT_STATE" 2>/dev/null || true
  else
    # query session active (fresh heartbeat) → index让位 by ADR-0060, stall expected
    hb_fresh=0
    if [ -f "$HEARTBEAT" ]; then
      hb_mtime=$(stat -c %Y "$HEARTBEAT" 2>/dev/null || stat -f %m "$HEARTBEAT" 2>/dev/null || echo 0)
      [ "$(( now - hb_mtime ))" -lt "$HEARTBEAT_TTL" ] && hb_fresh=1
    fi

    # remember when THIS pending remote SHA was first observed (grace window anchor)
    pend_sha=""; pend_ts=0
    if [ -f "$STATE_FILE" ]; then
      read -r pend_sha pend_ts < "$STATE_FILE" 2>/dev/null || true
    fi
    [ "$pend_sha" != "$remote" ] && { pend_sha="$remote"; pend_ts="$now"; }
    mkdir -p "$(dirname "$STATE_FILE")" 2>/dev/null || true
    printf '%s %s\n' "$pend_sha" "$pend_ts" > "$STATE_FILE" 2>/dev/null || true

    behind_min=$(( (now - pend_ts) / 60 ))
    report="${report}⏳ 落后 origin/${BRANCH} 已 ${behind_min}m（窗口 ${WINDOW_MIN}m）\n"
    if [ "$hb_fresh" -eq 1 ]; then
      report="${report}（query 会话活跃 — 按 ADR-0060 index 让位，暂不告警）\n"
    elif [ "$behind_min" -ge "$WINDOW_MIN" ]; then
      problems="${problems}接地检索增量停滞: origin/${BRANCH}@${remote:0:8} 已 ${behind_min}m 未进检索（last_sha=${last_sha:0:8}, 窗口 ${WINDOW_MIN}m）\n"
    fi
  fi
fi

# --- 4. tick timer liveness (proactive — catches a dead timer even when caught up) ---
if systemctl is-active --quiet "$TICK_TIMER"; then
  report="${report}timer: ✅ ${TICK_TIMER} active\n"
else
  problems="${problems}${TICK_TIMER} 未激活（增量 tick 已停 → 新代码不会进检索）\n"
  report="${report}timer: ❌ ${TICK_TIMER} inactive\n"
fi

# --- 5. stuck builder (the mode that leaves §4's timer check saying "healthy") ---
# A builder that hangs after its work parks the one-shot unit in `activating` forever, and
# OnUnitActiveSec= only schedules the next elapse once the current activation ends → the
# timer is `active` with Trigger `n/a` (2026-08-03: 17h of zero indexing, §4 said ✅).
# TimeoutStartSec= in the unit now caps the hang; this check makes the alert name the cause
# instead of only the drift. Unreadable timestamp → treat as just-started (never false-alarm).
if [ "$(systemctl show -p ActiveState --value "$TICK_SERVICE" 2>/dev/null)" = "activating" ]; then
  tick_started=$(systemctl show -p InactiveExitTimestamp --value "$TICK_SERVICE" 2>/dev/null)
  tick_started_ts=$(date --date="$tick_started" +%s 2>/dev/null || echo "$now")
  tick_run_min=$(( (now - tick_started_ts) / 60 ))
  if [ "$tick_run_min" -ge "$STUCK_MIN" ]; then
    problems="${problems}${TICK_SERVICE} 卡在 activating 已 ${tick_run_min}m（builder 挂死 → timer 虽 active 但不再排下一次 tick）\n"
    report="${report}tick: ❌ 卡在 activating ${tick_run_min}m（阈值 ${STUCK_MIN}m）\n"
  else
    report="${report}tick: ⏳ 正在跑 ${tick_run_min}m\n"
  fi
fi

printf '%b' "$report"

if [ -z "$problems" ]; then
  echo "✅ 接地检索增量正常"
  exit 0
fi

# The text contains BOTH "检索增量告警" and "告警" as contiguous substrings, so a
# Feishu 自定义关键词 bot accepts it whether its keyword is "检索增量告警" or the
# broader "告警". Feishu keyword match is contiguous-substring, so do NOT split the
# keyword (e.g. "…增量监控告警" would NOT contain "检索增量告警" and be rejected). The
# cert monitor's text ("…监控告警") also contains "告警", so one shared bot with
# keyword "告警" covers both.
# 飞书推送走共享 feishu-send.sh（NVY_ALERT_* 公共配置 + openssl 签名，免 python3）。
# 文案自带 [hostname] + 任务名（本脚本不经 nvy-run-reported wrapper，machine/task 须自带）。
# NVY_ALERT_WEBHOOK_URL 未设 → feishu_send 内部静默跳过（仅日志）。退出码恒为 1（systemd 标 failed）。
msg="$(printf '%b' "🔴 [$(hostname)] 接地检索增量告警:\n${problems}")"
printf '%s\n' "$msg" >&2

# --- 告警去重：同一问题在 REPEAT_MIN 内只推一次 ---
# 本脚本每 5min 跑一次，而故障是**持续态**：不去重就是刷屏（2026-08-08 那次 19h 的停滞推了
# 约 220 条）。刷屏和没有告警是同一种失效——都让人不再看这个 bot。检测与 exit 1 不受影响，
# 被抑制的只是推送，`systemctl --failed` 与 journal 始终看得到全貌。
# 签名把数字归一化，所以「已 275m」与「已 280m」是同一条；问题类别一变（ls-remote 失败 →
# drift 停滞）签名立刻变，新问题第一时间推得出去，不会被上一条的退避窗口盖住。
sig=$(printf '%b' "$problems" | sed -E 's/[0-9]+/N/g' | cksum | awk '{print $1}')
prev_sig=""; prev_push=0
if [ -f "$ALERT_STATE" ]; then
  read -r prev_sig prev_push < "$ALERT_STATE" 2>/dev/null || true
fi
[ -z "$prev_push" ] && prev_push=0

if [ "$sig" = "$prev_sig" ] && [ "$(( (now - prev_push) / 60 ))" -lt "$REPEAT_MIN" ]; then
  echo "[alert] 同一问题 ${REPEAT_MIN}m 内已推送过 — 仅日志（unit 仍标 failed）" >&2
else
  command -v feishu_send >/dev/null 2>&1 \
    && feishu_send "$msg" \
    || echo "[alert] feishu-send.sh 未载入 — 仅日志, 跳过推送" >&2
  mkdir -p "$(dirname "$ALERT_STATE")" 2>/dev/null || true
  printf '%s %s\n' "$sig" "$now" > "$ALERT_STATE" 2>/dev/null || true
fi

exit 1
