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
#   • 美股期权面           全量搬（锚 + 链合约 + 逐日快照 + 财报日历 + IV/指数），
#                          本地跑 045-048 期权台要真数据，见下方注册表逐条理由
#
# 扩展性（方案 C）：
#   • 列：每表列清单从 prod `information_schema` 按 ordinal_position **动态派生**，
#     export 与 import 用同一份有序列名（按名对齐，防列序漂移）。**新增列零改脚本**。
#   • 表：`TABLE_POLICIES` 声明式注册表（`schema.table`→策略 full/sample_or_recent/
#     sample_only/skip）。prod 出现**未注册**的新表 → 脚本 fail-loud（无声截断禁止），
#     逼一次显式决策；新增同步表 = 加一行声明。
#   • schema：`SYNC_SCHEMAS` 声明扫哪几个 schema。注册表键**一律全限定**（`schema.table`）——
#     裸表名跨 schema 会撞名，且 fail-loud 扫描的键必须与注册表同构，否则新 schema 的表
#     永远匹配不上任何注册项、每轮必假红。
#
# 对数校验：
#   每张表导出前取一次 prod 侧「同 WHERE 的 count(*)」，重灌后与本地 count(*) 逐表比对，
#   不等即 fail-loud。**这道闸是短读的唯一探测手段** —— `COPY TO STDOUT | ssh > file` 在
#   ssh 返 0 而数据被截断时，`set -euo pipefail` 抓不到，表现只是「通知里的数字小了一点」
#   （2026-08-10 实撞：instrument 静默丢尾部 308 行，本地 max(id) 停在 125435 而 prod 是
#   127038 —— 导出带 `ORDER BY 1` 故丢的恰好是 id 尾段）。
#   ⚠️ 已知假阳性窗口：prod 在「取 count → 导出完成」之间发生写入会误报。本机同步跑在
#   北京 09:05，us 维度 06:00、hk/cn 维度 22:00，窗口内静默 ⇒ 误报罕见，且误报是可见的
#   ❌ 而不是静默的错数据，方向正确。
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

# ─── 扫描 schema（fail-loud 新表检测的覆盖面）──────────────────────────────────
# 加 schema = 加一项 + 在 TABLE_POLICIES 里给它每张表一条声明（否则首轮即 fail-loud）。
SYNC_SCHEMAS=(marketdata optionsdesk)

# ─── 表注册表（schema.table → 取数策略）───────────────────────────────────────
# 策略: full=全量 / sample_or_recent=样本股全史+全股近窗(需 trade_date 列) /
#       sample_only=仅样本股(需 instrument_id 列) / skip=不同步。
# 键**必须全限定**（`schema.table`），见文件头「扩展性 · schema」那条。
# 顺序即重灌顺序：被 FK 引用的父表必须在子表之前 —— 实测 FK 三条：
#   earnings_event → instrument · option_contract → instrument · option_daily_snapshot → option_contract
#   （optionsdesk 两张表零 FK，位置自由，放末尾只为读起来分组清楚）
# prod 新增表未在此声明 → fail-loud；列变动无需改这里（列从 information_schema 派生）。
TABLE_POLICIES=(
  "marketdata.instrument:full"
  "marketdata.daily_bar:sample_or_recent"
  "marketdata.adjustment_factor:sample_only"
  "marketdata.corporate_action:sample_only"
  "marketdata.fundamental_snapshot:sample_only"
  "marketdata.financial_metric:sample_only"
  # ── 039-043 港股量化/事件/报告期/分类事实表（marketScope={hk}，均有 instrument_id）─────
  # 全 skip，两条理由：① SAMPLE_CODES 现全为 A 股、这些表港股专属 → 即便 sample_only 也导 0 行；
  # ② dev 无读 API、mobile 零消费（纯后端 sync + 一次性 backfill 内部表）。
  # 将来要本地联调港股：往 SAMPLE_CODES 加港股样本股（如 00700/00005）+ 把对应行改 sample_only 即点亮。
  "marketdata.short_selling_daily:skip"      # 039 做空日频
  "marketdata.connect_holding_daily:skip"    # 039 南向持股日频
  "marketdata.index_membership:skip"         # 039 所属指数（覆盖式快照，无 date）
  "marketdata.fund_holding:skip"             # 039 公募基金持股
  "marketdata.fund_company_holding:skip"     # 039 基金公司持股
  "marketdata.volatility_daily:skip"         # 040 历史波动率日频
  "marketdata.hot_snapshot:skip"             # 040 热度精选快照
  "marketdata.buyback_event:skip"            # 041 回购事件
  "marketdata.equity_change:skip"            # 041 股本变动
  "marketdata.shareholder_change:skip"       # 041 股东权益变动
  "marketdata.allotment_event:skip"          # 041 配股（零样本）
  "marketdata.revenue_segment:skip"          # 042 营收构成
  "marketdata.shareholder_snapshot:skip"     # 042 最新股东
  "marketdata.employee_snapshot:skip"        # 042 员工
  "marketdata.industry_classification:skip"  # 043 所属行业（覆盖式快照，无 date）
  "marketdata.announcement:skip"             # 043 公告元数据（HK 最大表 ~3M 行）
  # ── 美股期权面事实表（sellput-viz / 046 / 047；marketScope={us}）─────────────────
  # 全 full，两条理由：① 三张都是**美股专属**，而 SAMPLE_CODES 现全为 A 股 ⇒ sample_only
  #   恒导 0 行（us_index_daily 更是没有 instrument_id，压根无法按样本切）；
  # ② 体量小到可忽略：2026-08-07 实测合计约 2.2 万行（48 / 8216 / 14322），对照
  #   daily_bar 单表就 17 万行。而 046/047 的期权面直接吃这三张，设 skip 等于本地开发
  #   那些功能时手上没有 IV / VIX 数据。
  # 要改回不同步：把 full 改成 skip 即可（一行）。
  "marketdata.underlying_iv_daily:full"      # 标的 IV 当日快照
  "marketdata.underlying_iv_history:full"    # IV 历史（算分位）
  "marketdata.us_index_daily:full"           # VIX / VVIX（指数级，无 instrument_id）
  # ── 047 美股期权链 / 财报事实表（marketScope={us}）────────────────────────────────
  # 2026-08-10 由 skip 翻 full —— 起因是本地要跑 048 聚合视图，而它整片的输入就是这几张：
  # 没有 option_daily_snapshot 就一条腿都没有，三个聚合视图恒空，本地压根验不了。
  # 这三张都**切不出 A 股样本**（SAMPLE_CODES 现全为 A 股），别改成 sample_*，只有 full/skip 两态。
  # 🔻 翻 full 时的体量实测（2026-08-10，prod）：option_contract 7620 行 /
  #    option_daily_snapshot 17166 行（8 个 session：07-29 → 08-07）⇒ 合计约 2.5 万行，
  #    对照 daily_bar 单表 16 万行，当前**完全可忽略**。
  # 🚨 但 option_daily_snapshot 是仓内第一张**无上限增长**表（约 2150 行/交易日 ⇒ 一年约
  #    54 万行），而本脚本是「截断 → 重灌」全量语义 ⇒ 它会让同步**逐年变慢**。到那天的处置
  #    不是改回 skip（那等于本地又没数据），而是给它一条按 session_date 收窄的近窗策略
  #    —— 与 daily_bar 的 sample_or_recent 同形，只是窗口列换成 session_date。
  "marketdata.option_contract:full"          # 047 期权合约静态属性（父表，被 option_daily_snapshot FK 引用）
  "marketdata.option_daily_snapshot:full"    # 047 全链逐日快照（无上限增长，见上方 🚨）
  # ⚠️ prod 侧当前 **0 行**（2026-08-10 实测）：该维度 enabled + cron 已配 + next_fire_at 已排，
  #    但 sync_run 里 `sync:earnings_event` **一条运行记录都没有** ⇒ 从未跑过。此处翻 full 是
  #    为了「prod 有数据的那天本地自动跟上」，不代表现在能拿到财报打标数据。
  "marketdata.earnings_event:full"           # 047 财报事件日历
  # ── 运维 / 配置表（非标的级，dev 不需要）──────────────────────────────────────────
  "marketdata.calendar_sync_health:skip"     # 044 交易日历填充心跳（市场级 PK，无 instrument_id）
  "marketdata.trading_day:skip"        # 交易日历，dev 暂不需要（如需：改 full）
  "marketdata.sync_run:skip"           # 同步运行态，运维表
  "marketdata.sync_dimension:skip"     # 同步维度配置
  "marketdata.sync_dependency:skip"    # 同步依赖拓扑
  "marketdata.sync_blacklist:skip"     # 同步黑名单
  # ── optionsdesk：锚（045）—— 期权台一切的入口，无锚则雷达/详情/聚合三屏全是空态 ──────
  # 两张都 full 且**都切不出样本**（anchor 无 instrument_id，主键是 canonical ticker 字符串）。
  # 体量恒定在十几行量级（锚是人工维护的白名单，2026-08-10 prod = 12 / 12）。
  # 🚨 覆盖本地手工造的锚：本脚本是「截断 → 重灌」，跑完本地 anchor 就等于 prod 的那份。
  #    要在本地留自造锚做实验，得先把这两行改回 skip。
  "optionsdesk.anchor:full"                  # 045 愿买价锚（V / confidence / L 层 / excluded / 水位手选）
  "optionsdesk.anchor_change:full"           # 045 锚变更审计流水（无 FK，纯 anchor_id 引用）
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

# 流完整性哨兵 + 重试（2026-08-10 加）。
#
# 现象：`COPY TO STDOUT | ssh > file` 会**间歇性**在尾部截断，且 ssh 退出码仍是 0 ⇒
# `set -euo pipefail` 抓不到。当天两轮同步各丢 308 / 75 行 instrument，实证是按 id 排序的
# **干净前缀**（prod 中 `id <= 本地 max(id)` 的行数恰好等于本地总行数，且丢的那些行早就不再
# 被写入）⇒ 排除并发改动，就是传输截断。手动连跑 3 次却都完整 ⇒ 间歇性，不是必现。
#
# 两道**互补**的检法，缺一不可：
#
# ① **prod 侧 `| gzip -c`，本地 `gunzip -c`** —— gzip 流自带 CRC32 + 长度尾 ⇒ 传输被截断时
#    `gunzip` 自己非零退出（实测：`unexpected end of file` + exit 1）。截断检测由此下沉到
#    传输层，不再只靠应用层约定。顺带把字节压到约 1/5（instrument 实测 4871299 → 952576），
#    暴露窗口同比缩小。压缩跑在**宿主机**（`docker exec … | gzip -c` 的管道在 ssh 命令串里），
#    容器内零依赖；宿主 gzip 1.12 已核。
# ② **尾部哨兵**（COPY 之后再跑一条只回一行哨兵的 COPY）—— ① 盖不住「psql 中途报错但 gzip
#    正常收尾」这一类：那时 gz 流完好、gunzip 退出 0，只有哨兵缺失能说明数据不全。
#    🚫 别用 `\echo` —— 实测它会抢在 COPY 数据**之前**输出，摆在尾部反而检不出尾部截断。
#    🚫 也别用 `wc -l` 对行数 —— CSV 字段可含换行，行数 ≠ 记录数。
PROD_COPY_SENTINEL='__NVY_COPY_EOF__'
PROD_COPY_MAX_TRIES="${PROD_COPY_MAX_TRIES:-3}"

# prod COPY 导出：psql stdout → gzip（prod 侧）→ ssh → gunzip（本地）→ CSV（尾部哨兵剥掉）
prod_copy() {
  local sql="$1" out="$2" gz="$2.gz" full="$2.full" try
  for ((try = 1; try <= PROD_COPY_MAX_TRIES; try++)); do
    {
      printf 'COPY (%s) TO STDOUT WITH (FORMAT csv);\n' "$sql"
      printf "COPY (SELECT '%s') TO STDOUT WITH (FORMAT csv);\n" "$PROD_COPY_SENTINEL"
    } |
      ssh "${SSH_OPTS[@]}" "$PROD_SSH" \
        "docker exec -i $PROD_CTR psql -U $PROD_USER -d $PROD_DB -q -v ON_ERROR_STOP=1 | gzip -c" \
        >"$gz" || true # ssh 非零也走下面两道判定，统一由重试 / fail-loud 兜
    if gunzip -c "$gz" >"$full" 2>/dev/null && [[ "$(tail -1 "$full")" == "$PROD_COPY_SENTINEL" ]]; then
      sed '$d' "$full" >"$out" && rm -f "$gz" "$full"
      [[ "$try" == 1 ]] || echo "  ↻ 第 ${try} 次尝试才拿全（前 $((try - 1)) 次被截断）"
      return 0
    fi
  done
  fail "导出连续 ${PROD_COPY_MAX_TRIES} 次不完整（gunzip 失败 = 传输截断；哨兵缺失 = psql 中途报错，见 stderr）：${out}；中间件保留在 ${gz}"
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

# prod 派生的有序列名（来自 $TMP_DIR/_cols.tsv："schema.table|col1,col2,..."）。无匹配 → 空串。
# 🚨 用 awk 整字段等值比而非 `grep "^$1|"` —— 键含 `.`，在正则里是任意字符通配。
cols_for() { awk -F'|' -v t="$1" '$1 == t { print $2; exit }' "$TMP_DIR/_cols.tsv"; }

# 每表 prod 侧期望行数（同 WHERE），来自 $TMP_DIR/_expected.tsv："schema.table<TAB>n"。
expected_for() { awk -F'\t' -v t="$1" '$1 == t { print $2; exit }' "$TMP_DIR/_expected.tsv"; }

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
# 键 = `schema.table`（与 TABLE_POLICIES 同构）。schema 集合由 SYNC_SCHEMAS 声明。
schemas_in="$(printf "'%s'," "${SYNC_SCHEMAS[@]}")"; schemas_in="${schemas_in%,}"
prod_query "SELECT c.table_schema || '.' || c.table_name || '|' || string_agg(c.column_name, ',' ORDER BY c.ordinal_position)
  FROM information_schema.columns c
  JOIN information_schema.tables t
    ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
  WHERE c.table_schema IN ($schemas_in)
  GROUP BY c.table_schema, c.table_name;" >"$TMP_DIR/_cols.tsv"
[[ -s "$TMP_DIR/_cols.tsv" ]] || fail "prod information_schema 派生列清单为空（schema ${SYNC_SCHEMAS[*]} 不可见？）"
while IFS= read -r t; do
  [[ -n "$t" ]] || continue
  policy_for "$t" >/dev/null \
    || fail "检测到未注册的新表 $t — 请在 TABLE_POLICIES 声明同步策略（full/sample_or_recent/sample_only/skip）"
done < <(cut -d'|' -f1 "$TMP_DIR/_cols.tsv")

# ─── 2. 导出（prod COPY TO STDOUT，SSH 流式落 $TMP_DIR；列按 information_schema 有序派生）─
# 每表导出**前**紧邻取一次 prod 同 WHERE 的 count(*) 落 _expected.tsv，供 §4 对数。
# 紧邻取而非循环前统一取，是为把「取数 → 导出」之间的假阳性窗口压到单表导出耗时。
SYNCED_TABLES=() # 保留注册顺序 → 重灌按此序（父表先于子表，满足 FK）
: >"$TMP_DIR/_expected.tsv"
for e in "${TABLE_POLICIES[@]}"; do
  t="${e%%:*}"; pol="${e#*:}"
  [[ "$pol" == skip ]] && continue
  cols="$(cols_for "$t")"
  [[ -n "$cols" ]] || fail "表 $t 列派生为空（prod 无此表？检查 TABLE_POLICIES 拼写）"
  where="$(where_for "$pol")" || fail "未知同步策略 '$pol'（表 ${t}）"
  # 先落变量再写文件：命令替换直接嵌进 printf 时，prod_query 失败会被 printf 的成功掩盖
  exp_n="$(prod_query "SELECT count(*) FROM $t $where;")"
  [[ -n "$exp_n" ]] || fail "表 $t 的 prod 期望行数取空（prod 连通性 / 表不可见？）"
  printf '%s\t%s\n' "$t" "$exp_n" >>"$TMP_DIR/_expected.tsv"
  prod_copy "SELECT $cols FROM $t $where ORDER BY 1" "$TMP_DIR/$t.csv"
  echo "  导出 $t: $(wc -l <"$TMP_DIR/$t.csv" | tr -d ' ') 行（$(printf '%s' "$cols" | awk -F, '{print NF}') 列）"
  SYNCED_TABLES+=("$t")
done

# ─── 3. 截断 → 重灌 → 重置序列（单事务原子；失败回滚保旧数据）─────────────────
# SQL 动态生成：TRUNCATE 全部同步表（RESTART IDENTITY CASCADE）→ 逐表 \copy（显式有序列名，
# 按名对齐）→ 逐表 setval（pg_get_serial_sequence 为 null 的表[如无 id 列]自动跳过）。
trunc_list=""
for t in "${SYNCED_TABLES[@]}"; do trunc_list="$trunc_list${trunc_list:+, }$t"; done

reload_sql="SET client_min_messages = warning;
BEGIN;
TRUNCATE $trunc_list RESTART IDENTITY CASCADE;
"
for t in "${SYNCED_TABLES[@]}"; do
  cols="$(cols_for "$t")"
  reload_sql="$reload_sql\\copy $t ($cols) FROM '$TMP_DIR/$t.csv' WITH (FORMAT csv)
"
done
for t in "${SYNCED_TABLES[@]}"; do
  reload_sql="${reload_sql}SELECT setval(s.seq, GREATEST(s.mx, 1)) FROM (SELECT pg_get_serial_sequence('$t', 'id') AS seq, (SELECT max(id) FROM $t) AS mx) s WHERE s.seq IS NOT NULL;
"
done
reload_sql="${reload_sql}COMMIT;"
printf '%s\n' "$reload_sql" | local_psql -q >/dev/null

# ─── 4. 对数校验并上报（逐同步表：本地 count(*) MUST == prod 同 WHERE 的 count(*)）───
# 🚨 这道闸是**短读的唯一探测手段**，别为了让通知好看而降级成 warn —— 短读的表现就是
#    「数字小了一点」，不 fail 就等于没有（文件头「对数校验」段记了 2026-08-10 那次实撞）。
# 🚨 插值一律用 `${var}` 花括号：`$c` 紧跟全角字符时，bash 会把该字符的字节当成变量名的
#    一部分（实测 bash 5.3：`echo "本地=$c（差"` → `c\xef...: unbound variable`，set -u 直接退出）。
#    本仓的失败文案全是中文，这个坑在每一条 fail 消息上都成立。
parts=""
for t in "${SYNCED_TABLES[@]}"; do
  c="$(local_psql -tAc "SELECT count(*) FROM ${t}")"
  exp="$(expected_for "${t}")"
  [[ -n "$exp" ]] || fail "表 ${t} 缺 prod 期望行数（_expected.tsv 未写入，检查 §2 导出循环）"
  [[ "$c" == "$exp" ]] || fail "表 ${t} 行数不符：prod=${exp} 本地=${c}（差 $((exp - c))）—— 疑似 COPY 流被截断，重跑；连续复现则查 ssh/容器侧"
  parts="$parts${parts:+ / }${t}=${c}"
done
notify "✅ 同步完成（逐表已与 prod 对数）：${parts}（样本 ${hit_count} 支全历史 + 全股近 ${RECENT_DAYS} 日）"
