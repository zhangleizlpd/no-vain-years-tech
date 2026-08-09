#!/usr/bin/env bash
#
# marketdata-sync-report.sh — 每日 marketdata 夜间同步「逐维度成败 + 计数」报告（只读）。
#
# 读 prod `marketdata.sync_run`（夜间 22:00 tick 每维度落一行审计），按 sync_type 取窗口内
# 最近一行，格式化成人读摘要打 stdout；任一维度 failed / partial / 卡 running → 非零退出。
# 飞书推送由外层 `nvy-run-reported` wrapper 据退出码统一推 ✅/🔴（webhook/签名在 feishu-send.sh，
# 本脚本零飞书 I/O）—— 满足「新增调度复用既有飞书基建，不重写 webhook/token」（scheduled-tasks.md）。
#
# 只读 = 纯 SELECT（无任何写路径）。通路同 holdings/marketdata 只读取证：
#   docker exec -i <pg> psql -U <user> -d <db>（scheduled-tasks.md「故障排查」段）。
#
# 时窗为「滚动 N 小时」而非日历「当日」：tick 22:00 起、报告次晨 09:00 跑，跨午夜 →「当日」
# 会恒空（00:00-09:00 无 tick）。默认 18h 回看恰好罩住昨晚 22:00 tick、排除前晚（35h 外）。
#
# 零行判定（防周末/节假日「假停摆」误报）：非交易日 tick 全 marketScope 休市 → 短路不组 flow
# → **零 sync_run 行**（sync-tick-driver.ts:178-182 仅 log 不落行）。故窗口零行时再查 S1 的
# `trading_day` 表判「昨日是否交易日」区分真停摆 vs 正常非交易日：
#   · trading_day 近 30 日零行（表未 populate）→ 无法判定，保守告警  → exit 1
#   · **日历不健康（心跳陈旧 / 降级）→ 🔴 无法判定停摆**            → exit 1   ← 044 新增
#   · 昨日为交易日 → 🔴 夜间同步疑似停摆（该有行却没有）           → exit 1
#   · 昨日非交易日（表已 populate 且健康）→ ⏭️ 无同步属预期         → exit 0
#
# 🚨🚨 那一档「日历不健康」是本脚本的**循环信任盲区**修复（044 FR-012），别顺手删/改序 ——
# 它就是 2026-07 那次事故潜伏 2 天的**真凶**：
#   日历填充静默失败（per-market catch 只 WARN）→ `trading_day` 停止更新 → 夜间 tick 认为
#   「今天非交易日」→ 不组 flow → 零 sync_run 行 → **本看守读同一张已经坏掉的 trading_day**
#   → 判「昨日非交易日，无同步属预期」→ ⏭️ 放行 → 每天绿灯，无人知道 —— 直到 2 天后人工发现。
# 病根不是判据写错，而是**它拿那张可能已坏的表当判据**（循环信任：用被监控对象证明自己健康）。
# 修法 = 在「放行」之前先问一句「这张表还可信吗」，判据来自**表之外**的心跳（calendar_sync_health）。
#   ⇒ 顺序是承重的：健康档必须在「昨日非交易日 → 放行」**之前**。放到后面 = 盲区原样复活。
#
# 🚨 健康判断**不在本脚本里**：跑 044 的共享谓词文件 `marketdata-calendar-health.sql`（与 4h 探针
# `ops/jobs/marketdata-calendar-health.sh` **同一条**），该谓词由 Testcontainers IT 真测
# （`marketdata.calendar-044.health.it.spec.ts`：埋 25h/27h 心跳 + 主源/降级 served_by）。
# **禁止**在本脚本内联复制那段 SQL 或重写阈值/市场清单：两份必漂移，一漂移「判断已被真测」
# 就当场变成假话（仓内无 bash 测试框架 → bash 里的判断 = 无覆盖，撞宪法 §II NON-NEGOTIABLE）。
#
# Config — 可选 EnvironmentFile /etc/marketdata-sync-report.env（仅任务调参）：
#   SYNC_REPORT_PG_CONTAINER  postgres 容器（默认 nvy-tight-postgres-1 = prod）
#   SYNC_REPORT_PG_USER / _DB psql -U / -d（默认 mbw / mbw）
#   SYNC_REPORT_WINDOW_HOURS  回看窗口小时（默认 18）
#   CALENDAR_HEALTH_PREDICATE_SQL  044 共享健康谓词路径（默认 = 同目录 marketdata-calendar-health.sql）
set -uo pipefail

PG_CONTAINER="${SYNC_REPORT_PG_CONTAINER:-nvy-tight-postgres-1}"
PG_USER="${SYNC_REPORT_PG_USER:-mbw}"
PG_DB="${SYNC_REPORT_PG_DB:-mbw}"
WINDOW_HOURS="${SYNC_REPORT_WINDOW_HOURS:-18}"
# 044 共享健康谓词（**唯一判断所在地**，禁内联复制）。
# 🚨 2026-08-07 ops/jobs 扁平化前这里是**跨目录**相对路径（`../marketdata-calendar-health/`），
# 装机后解析不到，只能靠 .service 里一行 `Environment=CALENDAR_HEALTH_PREDICATE_SQL=` 兜住 ——
# 一份路径知识分散在两处、且仓内与机上形状不同。扁平化后两侧都是同目录兄弟，那行 Environment=
# 已随之删除。**别再把谓词挪去别的目录**，挪了就要把那根拐杖重新长回来。
_self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREDICATE_SQL="${CALENDAR_HEALTH_PREDICATE_SQL:-$_self_dir/marketdata-calendar-health.sql}"

case "$WINDOW_HOURS" in
  '' | *[!0-9]*) echo "[report] SYNC_REPORT_WINDOW_HOURS 须为非负整数，实得: $WINDOW_HOURS" >&2; exit 2 ;;
esac

# 单参 helper：跑一段只读 SQL，tuples-only + tab 分隔（-A 不对齐 / -t 无表头脚注 / -q 静默）。
psql_ro() {
  docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" \
    -X -q -At -F $'\t' -v ON_ERROR_STOP=1 -c "$1"
}

# 同上，但跑一个只读 SQL **文件**（stdin 喂 `psql -f -`）。专给 044 共享健康谓词用 ——
# 谓词必须**读文件**，见脚本头「禁止内联复制」。谓词自包含无参数（阈值写死在 SQL 内）→ 无 -v 传参。
psql_ro_file() {
  docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" \
    -X -q -At -F $'\t' -v ON_ERROR_STOP=1 -f - < "$1"
}

# ── 主查询：窗口内每 sync_type 最近一行（DISTINCT ON），失败态在前便于扫读 ──────────────────
# failed_targets 明细仅对问题态展开（success/skipped 不展开）；剔 tab/换行防坏字段分隔、截 400 字。
AGG_SQL="SELECT
  sync_type,
  status,
  scanned, ok, skipped, failed,
  to_char(started_at AT TIME ZONE 'Asia/Shanghai', 'MM-DD HH24:MI'),
  (finished_at IS NULL),
  CASE WHEN status IN ('success','skipped') OR failed_targets IS NULL THEN ''
       ELSE left(regexp_replace(failed_targets::text, '[\t\n\r]+', ' ', 'g'), 400) END
FROM (
  SELECT DISTINCT ON (sync_type) *
  FROM marketdata.sync_run
  WHERE started_at >= now() - make_interval(hours => ${WINDOW_HOURS})
  ORDER BY sync_type, started_at DESC
) t
ORDER BY CASE status WHEN 'failed' THEN 0 WHEN 'partial' THEN 1 WHEN 'running' THEN 2
                     WHEN 'success' THEN 3 WHEN 'skipped' THEN 4 ELSE 5 END, sync_type;"

rows="$(psql_ro "$AGG_SQL" 2>&1)"
rc=$?
if [ "$rc" -ne 0 ]; then
  printf '查询 marketdata.sync_run 失败 (rc=%s):\n%s\n' "$rc" "$rows" >&2
  exit 1
fi

# ── 窗口零行 → 交由 trading_day 表区分「真停摆」vs「正常非交易日」───────────────────────────
if [ -z "${rows//[$'\t\n ']/}" ]; then
  diag="$(psql_ro "SELECT
    (SELECT count(*) FROM marketdata.trading_day WHERE date = (now() AT TIME ZONE 'Asia/Shanghai')::date - 1),
    (SELECT count(*) FROM marketdata.trading_day WHERE date >= (now() AT TIME ZONE 'Asia/Shanghai')::date - 30);" 2>&1)"
  drc=$?
  if [ "$drc" -ne 0 ]; then
    printf '窗口 %sh 内零 sync_run，且 trading_day 判定查询失败 (rc=%s):\n%s\n' "$WINDOW_HOURS" "$drc" "$diag" >&2
    exit 1
  fi
  IFS=$'\t' read -r y_trading recent_pop <<<"$diag"
  y_trading="${y_trading:-0}"; recent_pop="${recent_pop:-0}"

  if [ "$recent_pop" -eq 0 ]; then
    printf '⚠️ 窗口 %sh 内零 sync_run，且 trading_day 近 30 日为空（表未 populate）→ 无法判定停摆，保守告警\n' "$WINDOW_HOURS" >&2
    exit 1
  fi

  # ── 🚨 循环信任闸（044 FR-012）：先问「trading_day 这张表还可信吗」，再拿它判停摆 ──────────
  # **必须在下面「昨日非交易日 → 放行」之前**——顺序即修复本身（详见脚本头「真凶」段）。
  # 判断全在谓词里（server IT 真测），这里只消费它给的 exit_code，不重写任何阈值/市场清单。
  cal_row="$(psql_ro_file "$PREDICATE_SQL" 2>&1)"
  crc=$?
  if [ "$crc" -ne 0 ]; then
    printf '⚠️ 窗口 %sh 内零 sync_run，且日历健康谓词查询失败 (rc=%s) → 无法判定停摆，保守告警:\n%s\n' \
      "$WINDOW_HOURS" "$crc" "$cal_row" >&2
    exit 1
  fi
  IFS=$'\t' read -r cal_unhealthy cal_summary <<<"$cal_row"
  # 缺省取 1（不健康）而非 0：谓词没给出可信答案时**倒向告警**——沉默 ≠ 健康，那正是本次事故的形状。
  if [ "${cal_unhealthy:-1}" -ne 0 ]; then
    printf '🔴 窗口 %sh 内零 sync_run，且**日历不健康，无法判定停摆**（trading_day 可能已陈旧 →\n' "$WINDOW_HOURS" >&2
    printf '   「昨日非交易日」这个结论本身不可信，不予放行）: %s\n' "${cal_summary:-谓词返回异常: $cal_row}" >&2
    exit 1
  fi

  # 走到这里 = 日历健康 ⇒ trading_day 可信 ⇒ 下面两档（既有能力，FR-013 不回归）判据成立。
  if [ "$y_trading" -gt 0 ]; then
    printf '🔴 窗口 %sh 内零 sync_run，但昨日为交易日 → 夜间同步疑似停摆（tick 未跑 / worker 无 job）\n' "$WINDOW_HOURS" >&2
    exit 1
  fi
  printf '⏭️ 窗口 %sh 内零 sync_run —— 日历健康且昨日非交易日，无夜间同步属预期（%s）\n' \
    "$WINDOW_HOURS" "$cal_summary"
  exit 0
fi

# ── 格式化逐维度摘要 ─────────────────────────────────────────────────────────────────────
declare -i n_total=0 n_ok=0 n_bad=0 n_skip=0 n_other=0 problems=0
report=""
while IFS=$'\t' read -r stype status scanned ok skipped failed started unfinished ft; do
  [ -z "${stype:-}" ] && continue
  n_total+=1
  case "$status" in
    success) icon="✅"; n_ok+=1 ;;
    partial) icon="⚠️"; n_bad+=1; problems=1 ;;
    failed)  icon="🔴"; n_bad+=1; problems=1 ;;
    running) icon="⏳"; n_other+=1; problems=1 ;; # 昨晚起卡 running 未收尾 = 异常
    skipped) icon="⏭️"; n_skip+=1 ;;
    *)       icon="❓"; n_other+=1; problems=1 ;;
  esac
  line="$(printf '%s %-26s %-8s scanned=%s ok=%s skip=%s fail=%s  @%s' \
    "$icon" "$stype" "$status" "$scanned" "$ok" "$skipped" "$failed" "$started")"
  [ "$unfinished" = "t" ] && line="$line  ⚠未收尾"
  report="${report}${line}"$'\n'
  [ -n "$ft" ] && report="${report}     ↳ ${ft}"$'\n'
done <<<"$rows"

printf '%s' "$report"
printf '—— 合计 %s 维度: %s✅ %s🔴/⚠ %s⏭ %s❓ · 窗口 %sh · %s\n' \
  "$n_total" "$n_ok" "$n_bad" "$n_skip" "$n_other" "$WINDOW_HOURS" "$PG_CONTAINER"

# ── 复权因子质量闸 ───────────────────────────────────────────────────────────────────────
#
# 因子锚定走「事件条款法 + 涨跌幅复权法」2-of-2 判定：两法分歧或均不可解 → 落 factorBackward=1
# + status='needs_review'（读时等价「无此事件」，失真有界，但**该标的那段历史确实没被复权**）。
# 这类降级在 sync_run 里看不见 —— 维度照样 success，因为锚定没失败，是「算不出」。
#
# 🚨 护栏条件必须对执行方可观测（claude-config-layout 通用 invariant）：不打出来，
# needs_review 就是个只有翻库才看得见的静默降级，闸等于没有。
#
# 判红阈值只看**新增**（近 48h 写入）：存量 legacy_vendor_anchor 行是历史包袱，全量重算前
# 一直在，天天判红会让人学会无视这份报告 —— 那等于闸失效。存量只报数不判红。
# 列存在性先探：`status`/`source` 由 factor 算法换口径那次 migration 引入。ops 脚本与 app
# 镜像是**两条独立的上线通路**（脚本随 host 上的 git pull 走，迁移随部署走），必然存在一段
# 「脚本已更新、迁移未上」的窗口。那段时间应当明确报「闸未生效」而不是判红（假红会训练人
# 无视报告），也不能静默跳过（那就分不清「闸没开」和「没问题」）。
FACTOR_COL_SQL="SELECT count(*) FROM information_schema.columns
 WHERE table_schema = 'marketdata' AND table_name = 'adjustment_factor' AND column_name = 'status'"

FACTOR_SQL="SELECT
  count(*) FILTER (WHERE status = 'needs_review'),
  count(*) FILTER (WHERE status = 'needs_review' AND created_at >= now() - interval '48 hours'),
  count(*) FILTER (WHERE source = 'legacy_vendor_anchor'),
  count(*)
FROM marketdata.adjustment_factor"

factor_col="$(psql_ro "$FACTOR_COL_SQL" 2>&1 || echo ERR)"
if [ "$factor_col" = "0" ]; then
  printf '⏭️ 复权因子质量闸: adjustment_factor.status 列尚未上线（迁移未部署）→ 本轮闸未生效\n'
elif factor_row="$(psql_ro "$FACTOR_SQL" 2>&1)" && [ -n "$factor_row" ]; then
  IFS=$'\t' read -r f_review f_review_new f_legacy f_total <<<"$factor_row"
  if [ "${f_review:-0}" -gt 0 ] || [ "${f_legacy:-0}" -gt 0 ]; then
    if [ "${f_review_new:-0}" -gt 0 ]; then
      icon="🔴"; problems=1
    else
      icon="ℹ️"
    fi
    printf '%s 复权因子: needs_review=%s (近48h新增 %s) · 待重算 legacy=%s · 共 %s 行\n' \
      "$icon" "$f_review" "$f_review_new" "$f_legacy" "$f_total"
    [ "${f_review_new:-0}" -gt 0 ] && printf '     ↳ 定位: 查 app 日志 "factor needs_review" (含 exDate + 两法各自算出的值)\n'
  fi
else
  # 查不到不静默吞：闸自己坏了要看得见（列缺失 / 迁移未上 / 权限变化都会走到这里）。
  printf '❓ 复权因子质量闸查询失败（闸失效，非数据健康）: %s\n' "$factor_row" >&2
  problems=1
fi

exit "$problems"
