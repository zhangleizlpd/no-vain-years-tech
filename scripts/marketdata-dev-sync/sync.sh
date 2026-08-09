#!/usr/bin/env bash
#
# sync.sh — 每日从 prod 抽样同步「投资域测试数据」到本地 dev PG（仅本地联调用）。
#
# 形态（精简但自洽）：
#   • instrument            全量搬（任何股可搜/选）
#   • daily_bar             全股最近 RECENT_DAYS 个交易日 + 样本股全历史
#   • adjustment_factor /   仅随样本股（与「样本股全功能、非样本股仅近端价」一致）
#     corporate_action /
#     fundamental_snapshot /
#     financial_metric
#
# 扩展性（方案 C）：
#   • 列：每表列清单从 prod `information_schema` 按 ordinal_position **动态派生**，
#     export 与 import 用同一份有序列名（按名对齐，防列序漂移）。**新增列零改脚本**。
#   • 表：`TABLE_POLICIES` 声明式注册表（表→策略 full/sample_or_recent/sample_only/skip）。
#     prod 出现**未注册**的新表 → 脚本 fail-loud（无声截断禁止），逼一次显式决策；
#     新增同步表 = 加一行声明。
#
# 无密钥：
#   • prod 侧 = 免密 SSH(admin@…) + 容器内 `docker exec -i psql`（unix socket trust），
#     纯 `COPY (...) TO STDOUT` / `information_schema` 只读 SELECT（无 prod 写，不触发 auto-mode）；
#   • 本地侧 = mbw:mbw@localhost:5433/mbw_poc（非密钥，已在 apps/server/.env.example）。
#
# 可重复语义：每次全量「截断 → 重灌」（事务原子）。近窗自然滚动、样本股新交易日自动追加。
#
# 前置：本地 dev schema 已迁移（首次需 `cd apps/server && pnpm prisma migrate deploy`）。
#       本地缺 prod 已有的列 → \copy fail-fast（提示 migrate deploy），不静默丢列。
#
# 用法：pnpm dev-marketdata:sync   或   bash scripts/marketdata-dev-sync/sync.sh
#
set -euo pipefail

# ─── 可改变量（均可经 env 覆盖）────────────────────────────────────────────────
SAMPLE_CODES=(600519 601318 601398 600900 600036 000001 000858 000002 000651 \
              300750 300059 688981 688111 920819 601899)
RECENT_DAYS="${RECENT_DAYS:-20}"

# prod 主机（代号 `app`）的真实绑定不入库 —— 从仓外 fleet.env 解析
# (per docs/conventions/information-boundary.md)。launchd 不继承交互 shell 的 env，
# 故必须在脚本内显式 source，不能指望调用方导出。
[ -f "$HOME/.nvy/fleet.env" ] && . "$HOME/.nvy/fleet.env"
PROD_SSH="${PROD_SSH:-${NVY_APP_SSH:?缺 NVY_APP_SSH —— 在 ~/.nvy/fleet.env 里按 ops/host/fleet.env.example 填}}"
PROD_CTR="${PROD_CTR:-nvy-tight-postgres-1}"
PROD_USER="${PROD_USER:-mbw}"
PROD_DB="${PROD_DB:-mbw}"

LOCAL_HOST="${LOCAL_HOST:-localhost}"
LOCAL_PORT="${LOCAL_PORT:-5433}"
LOCAL_USER="${LOCAL_USER:-mbw}"
LOCAL_PW="${LOCAL_PW:-mbw}"
LOCAL_DB="${LOCAL_DB:-mbw_poc}"
LOCAL_CTR="${LOCAL_CTR:-mbw-poc-postgres}"

# §0 自愈用的 compose 文件。优先用与本脚本同目录的副本（部署态：setup 拷到 ~/.nvy）；
# 退而求其次用 repo 根的原件（开发态：直接 `bash scripts/.../sync.sh`）。两者都找不到 → 空。
COMPOSE_FILE="${COMPOSE_FILE:-}"
if [[ -z "$COMPOSE_FILE" ]]; then
  for _c in "$(dirname "${BASH_SOURCE[0]}")/docker-compose.dev.yml" \
            "$(dirname "${BASH_SOURCE[0]}")/../../docker-compose.dev.yml"; do
    [[ -f "$_c" ]] && { COMPOSE_FILE="$_c"; break; }
  done
fi

# 注：本脚本刻意不依赖任何 ~/Documents 下的 repo 文件——launchd agent 对 ~/Documents 无
# TCC 权限。setup 把本脚本 + docker-compose.dev.yml 一并拷到 ~/.nvy 下，故 §0 用那份副本
# `compose up` 重建容器（`docker start` 救不回被日常 teardown `compose down` 移除的容器）。

SSH_OPTS=(-o ConnectTimeout=20 -o BatchMode=yes)

LOG_DIR="$HOME/.nvy/marketdata-dev-sync"
LOG_FILE="$LOG_DIR/sync.log"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mbw-seed.XXXXXX")"

# ─── 表注册表（表 → 取数策略）─────────────────────────────────────────────────
# 策略: full=全量 / sample_or_recent=样本股全史+全股近窗(需 trade_date 列) /
#       sample_only=仅样本股(需 instrument_id 列) / skip=不同步。
# 顺序即重灌顺序：被 FK 引用的父表（instrument）必须在子表之前。
# prod 新增表未在此声明 → fail-loud；列变动无需改这里（列从 information_schema 派生）。
TABLE_POLICIES=(
  "instrument:full"
  "daily_bar:sample_or_recent"
  "adjustment_factor:sample_only"
  "corporate_action:sample_only"
  "fundamental_snapshot:sample_only"
  "financial_metric:sample_only"
  # ── 039-043 港股量化/事件/报告期/分类事实表（marketScope={hk}，均有 instrument_id）─────
  # 全 skip，两条理由：① SAMPLE_CODES 现全为 A 股、这些表港股专属 → 即便 sample_only 也导 0 行；
  # ② dev 无读 API、mobile 零消费（纯后端 sync + 一次性 backfill 内部表）。
  # 将来要本地联调港股：往 SAMPLE_CODES 加港股样本股（如 00700/00005）+ 把对应行改 sample_only 即点亮。
  "short_selling_daily:skip"      # 039 做空日频
  "connect_holding_daily:skip"    # 039 南向持股日频
  "index_membership:skip"         # 039 所属指数（覆盖式快照，无 date）
  "fund_holding:skip"             # 039 公募基金持股
  "fund_company_holding:skip"     # 039 基金公司持股
  "volatility_daily:skip"         # 040 历史波动率日频
  "hot_snapshot:skip"             # 040 热度精选快照
  "buyback_event:skip"            # 041 回购事件
  "equity_change:skip"            # 041 股本变动
  "shareholder_change:skip"       # 041 股东权益变动
  "allotment_event:skip"          # 041 配股（零样本）
  "revenue_segment:skip"          # 042 营收构成
  "shareholder_snapshot:skip"     # 042 最新股东
  "employee_snapshot:skip"        # 042 员工
  "industry_classification:skip"  # 043 所属行业（覆盖式快照，无 date）
  "announcement:skip"             # 043 公告元数据（HK 最大表 ~3M 行）
  # ── 美股期权面事实表（sellput-viz / 046 / 047；marketScope={us}）─────────────────
  # 全 full，两条理由：① 三张都是**美股专属**，而 SAMPLE_CODES 现全为 A 股 ⇒ sample_only
  #   恒导 0 行（us_index_daily 更是没有 instrument_id，压根无法按样本切）；
  # ② 体量小到可忽略：2026-08-07 实测合计约 2.2 万行（48 / 8216 / 14322），对照
  #   daily_bar 单表就 17 万行。而 046/047 的期权面直接吃这三张，设 skip 等于本地开发
  #   那些功能时手上没有 IV / VIX 数据。
  # 要改回不同步：把 full 改成 skip 即可（一行）。
  "underlying_iv_daily:full"      # 标的 IV 当日快照
  "underlying_iv_history:full"    # IV 历史（算分位）
  "us_index_daily:full"           # VIX / VVIX（指数级，无 instrument_id）
  # ── 047 美股期权链 / 财报事实表（marketScope={us}）────────────────────────────────
  # 全 skip，三条理由：① 与上面港股那批同款 —— SAMPLE_CODES 现全为 A 股、这三张美股期权专属
  #   ⇒ 即便 sample_only 也恒导 0 行；② 047 的测试都不吃本地真数据（mobile e2e 用 hermetic
  #   mock、契约冒烟用 testcontainers 自造）；③ option_daily_snapshot 是仓内第一张**无上限
  #   增长**表（实测一轮 9664 行/天 ⇒ 一年约 240 万行），而本脚本是「截断 → 重灌」全量语义，
  #   全拷会让同步逐日变慢。
  # 将来要本地联调美股期权：把对应行改 full 即点亮（这三张都切不出 A 股样本，别用 sample_*）。
  "option_contract:skip"          # 047 期权合约静态属性（父表，被 option_daily_snapshot FK 引用）
  "option_daily_snapshot:skip"    # 047 全链逐日快照（无上限增长）
  "earnings_event:skip"           # 047 财报事件日历
  # ── 运维 / 配置表（非标的级，dev 不需要）──────────────────────────────────────────
  "calendar_sync_health:skip"     # 044 交易日历填充心跳（市场级 PK，无 instrument_id）
  "trading_day:skip"        # 交易日历，dev 暂不需要（如需：改 full）
  "sync_run:skip"           # 同步运行态，运维表
  "sync_dimension:skip"     # 同步维度配置
  "sync_dependency:skip"    # 同步依赖拓扑
  "sync_blacklist:skip"     # 同步黑名单
)

# ─── 工具函数 ─────────────────────────────────────────────────────────────────
beijing_now() { TZ=Asia/Shanghai date '+%Y-%m-%d %H:%M:%S'; }

# 落日志 + macOS 桌面通知（headless 无 TTY，靠通知/日志回溯结果）
notify() {
  local msg="$1"
  mkdir -p "$LOG_DIR"
  printf '[%s] %s\n' "$(beijing_now)" "$msg" >>"$LOG_FILE"
  echo "$msg"
  if [[ "$(uname)" == 'Darwin' ]]; then
    local osa='on run argv
 display notification (item 1 of argv) with title (item 2 of argv)
end run'
    osascript -e "$osa" "$msg" 'marketdata 测试数据同步' >/dev/null 2>&1 || true
  fi
}

cleanup() { rm -rf "$TMP_DIR"; }
# fail 是 ERR trap 处理器：先解绑 ERR 防 fail 内部命令失败再触发递归。
# 飞书推送不在此处——由外层通用 wrapper nvy-run-reported 据本脚本非零退出码统一推（含 notify 的 stdout 文案）。
fail() {
  trap - ERR
  notify "❌ 同步失败（行 ${1:-?}）；详见 $LOG_DIR/launchd.log"
  exit 1
}
trap cleanup EXIT
trap 'fail $LINENO' ERR

# prod 只读标量/多行查询：SQL 经 stdin 喂给容器内 psql，避免跨 ssh 的嵌套引号地狱
prod_query() {
  printf '%s\n' "$1" |
    ssh "${SSH_OPTS[@]}" "$PROD_SSH" \
      "docker exec -i $PROD_CTR psql -U $PROD_USER -d $PROD_DB -tAq -v ON_ERROR_STOP=1"
}

# prod COPY 导出：`COPY (...) TO STDOUT` 数据经 psql stdout → ssh → 落本地 CSV
prod_copy() {
  local sql="$1" out="$2"
  printf 'COPY (%s) TO STDOUT WITH (FORMAT csv)\n' "$sql" |
    ssh "${SSH_OPTS[@]}" "$PROD_SSH" \
      "docker exec -i $PROD_CTR psql -U $PROD_USER -d $PROD_DB -q -v ON_ERROR_STOP=1" \
      >"$out"
}

local_psql() {
  PGPASSWORD="$LOCAL_PW" psql -h "$LOCAL_HOST" -p "$LOCAL_PORT" -U "$LOCAL_USER" -d "$LOCAL_DB" \
    -v ON_ERROR_STOP=1 "$@"
}

# 注册表查询（bash 3.2 无关联数组 → 索引数组 + 线性查找）
policy_for() { # echo 表的策略；未注册 → return 1
  local t="$1" e
  for e in "${TABLE_POLICIES[@]}"; do
    case "$e" in "$t:"*) echo "${e#*:}"; return 0 ;; esac
  done
  return 1
}

# prod 派生的有序列名（来自 $TMP_DIR/_cols.tsv："table|col1,col2,..."）。无匹配 → 空串（不触发 set -e）
cols_for() { grep "^$1|" "$TMP_DIR/_cols.tsv" | head -1 | cut -d'|' -f2- || true; }

where_for() { # 策略 → WHERE 子句（full 无 WHERE）
  case "$1" in
    full) echo "" ;;
    sample_only) echo "WHERE instrument_id IN ($SAMPLE_IDS)" ;;
    sample_or_recent) echo "WHERE instrument_id IN ($SAMPLE_IDS) OR trade_date >= '$CUTOFF'" ;;
    *) return 1 ;;
  esac
}

# ─── 0. 保险拉起本地 dev stack（晨间无人值守；日常收工 teardown 的 `compose down` 会
#        移除容器，`docker start` 救不回被移除的容器，故优先 `compose up` 重建）──────────
notify "▶ 开始同步（样本 ${#SAMPLE_CODES[@]} 支，近窗 ${RECENT_DAYS} 交易日）"
if [[ -n "$COMPOSE_FILE" ]]; then
  docker compose -f "$COMPOSE_FILE" up -d >/dev/null 2>&1 || true
else
  docker start "$LOCAL_CTR" >/dev/null 2>&1 || true   # 兜底：找不到 compose 文件时退回旧行为
fi
ready=0
for _ in $(seq 1 30); do
  if local_psql -tAc 'SELECT 1' >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[[ "$ready" == 1 ]] || fail "本地 dev PG 未就绪（$LOCAL_HOST:${LOCAL_PORT}）——compose up 重建失败，检查 OrbStack/Docker 是否运行"

# ─── 1. 解析样本 id + 近窗 cutoff（prod 只读）─────────────────────────────────
codes_in="$(printf "'%s'," "${SAMPLE_CODES[@]}")"; codes_in="${codes_in%,}"
SAMPLE_IDS="$(prod_query "SELECT string_agg(id::text, ',') FROM marketdata.instrument WHERE code IN ($codes_in);")"
hit_count="$(prod_query "SELECT count(*) FROM marketdata.instrument WHERE code IN ($codes_in);")"
CUTOFF="$(prod_query "SELECT min(trade_date) FROM (SELECT DISTINCT trade_date FROM marketdata.daily_bar ORDER BY trade_date DESC LIMIT $RECENT_DAYS) t;")"
[[ -n "$SAMPLE_IDS" ]] || fail "样本股解析为空（检查 SAMPLE_CODES / prod 连通）"
[[ -n "$CUTOFF" ]] || fail "近窗 cutoff 解析为空"
echo "  样本命中 $hit_count/${#SAMPLE_CODES[@]} 支；近窗 cutoff = $CUTOFF"

# ─── 1.5 派生列清单 + 未注册新表 fail-loud（prod 只读 information_schema）──────────
prod_query "SELECT c.table_name || '|' || string_agg(c.column_name, ',' ORDER BY c.ordinal_position)
  FROM information_schema.columns c
  JOIN information_schema.tables t
    ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
  WHERE c.table_schema = 'marketdata'
  GROUP BY c.table_name;" >"$TMP_DIR/_cols.tsv"
[[ -s "$TMP_DIR/_cols.tsv" ]] || fail "prod information_schema 派生列清单为空（schema marketdata 不可见？）"
while IFS= read -r t; do
  [[ -n "$t" ]] || continue
  policy_for "$t" >/dev/null \
    || fail "检测到未注册的新表 marketdata.$t — 请在 TABLE_POLICIES 声明同步策略（full/sample_or_recent/sample_only/skip）"
done < <(cut -d'|' -f1 "$TMP_DIR/_cols.tsv")

# ─── 2. 导出（prod COPY TO STDOUT，SSH 流式落 $TMP_DIR；列按 information_schema 有序派生）─
SYNCED_TABLES=() # 保留注册顺序 → 重灌按此序（父表先于子表，满足 FK）
for e in "${TABLE_POLICIES[@]}"; do
  t="${e%%:*}"; pol="${e#*:}"
  [[ "$pol" == skip ]] && continue
  cols="$(cols_for "$t")"
  [[ -n "$cols" ]] || fail "表 marketdata.$t 列派生为空（prod 无此表？检查 TABLE_POLICIES 拼写）"
  where="$(where_for "$pol")" || fail "未知同步策略 '$pol'（表 ${t}）"
  prod_copy "SELECT $cols FROM marketdata.$t $where ORDER BY 1" "$TMP_DIR/$t.csv"
  echo "  导出 $t: $(wc -l <"$TMP_DIR/$t.csv" | tr -d ' ') 行（$(printf '%s' "$cols" | awk -F, '{print NF}') 列）"
  SYNCED_TABLES+=("$t")
done

# ─── 3. 截断 → 重灌 → 重置序列（单事务原子；失败回滚保旧数据）─────────────────
# SQL 动态生成：TRUNCATE 全部同步表（RESTART IDENTITY CASCADE）→ 逐表 \copy（显式有序列名，
# 按名对齐）→ 逐表 setval（pg_get_serial_sequence 为 null 的表[如无 id 列]自动跳过）。
trunc_list=""
for t in "${SYNCED_TABLES[@]}"; do trunc_list="$trunc_list${trunc_list:+, }marketdata.$t"; done

reload_sql="SET client_min_messages = warning;
BEGIN;
TRUNCATE $trunc_list RESTART IDENTITY CASCADE;
"
for t in "${SYNCED_TABLES[@]}"; do
  cols="$(cols_for "$t")"
  reload_sql="$reload_sql\\copy marketdata.$t ($cols) FROM '$TMP_DIR/$t.csv' WITH (FORMAT csv)
"
done
for t in "${SYNCED_TABLES[@]}"; do
  reload_sql="${reload_sql}SELECT setval(s.seq, GREATEST(s.mx, 1)) FROM (SELECT pg_get_serial_sequence('marketdata.$t', 'id') AS seq, (SELECT max(id) FROM marketdata.$t) AS mx) s WHERE s.seq IS NOT NULL;
"
done
reload_sql="${reload_sql}COMMIT;"
printf '%s\n' "$reload_sql" | local_psql -q >/dev/null

# ─── 4. 校验并上报（逐同步表计数）────────────────────────────────────────────
parts=""
for t in "${SYNCED_TABLES[@]}"; do
  c="$(local_psql -tAc "SELECT count(*) FROM marketdata.$t")"
  parts="$parts${parts:+ / }$t=$c"
done
notify "✅ 同步完成：${parts}（样本 ${hit_count} 支全历史 + 全股近 ${RECENT_DAYS} 日）"
