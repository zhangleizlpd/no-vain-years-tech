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
#   • 美股期权面           锚 + 链合约 + 财报日历 + IV/指数全量搬；**逐日快照只搬近窗**
#                          （最近 OPTION_RECENT_DAYS 个自然日，按 session_date 切——它是
#                          仓内唯一无上限增长表，见下方注册表 🔻）。本地跑 045-048 期权台
#                          要真数据，见注册表逐条理由
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

# 期权逐日快照的近窗，单位 = **自然日**（按 session_date 直接切）。
# 🚨 刻意不复用上面的 RECENT_DAYS：那个的单位是**交易日**（先去 daily_bar 里取 distinct
#    trade_date 的第 N 个当 cutoff），两者量纲不同；合成一个 env 之后「调 A 股近窗」会静默
#    改掉期权链的体量，反过来也一样 —— 而这类耦合的错法不报错，只让数字悄悄变。
# 取 30 天的依据（消费端实测下界 + 体量上界两头夹）：
#   • 功能下界 = **2 个 session**：get-legs.usecase.ts 只取 sessionDate desc 的最近一期
#     （findFirst + 该期 findMany）；option-snapshot-coverage.check.ts 要「基线日 + 当日」
#     两期；server IT 走 testcontainers 自造 fixture，压根不吃 dev 库。30 自然日 ≈ 21 个
#     交易日，对 2 的下界有一个数量级的余量（含长假）。
#   • 体量上界 ≈ 21 × 7000 ≈ **14.7 万行**，与 daily_bar 现有约 16 万行同量级。
OPTION_RECENT_DAYS="${OPTION_RECENT_DAYS:-30}"

# 单表体量趋势闸（只 warn 不 fail，见 §2）。默认 30 万行 —— 依据写在 §2 触发点旁。
ROW_WARN_THRESHOLD="${ROW_WARN_THRESHOLD:-300000}"

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
#       sample_only=仅样本股(需 instrument_id 列) / recent_sessions=仅近窗(需 session_date 列) /
#       skip=不同步。
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
  # 这三张都**切不出 A 股样本**（SAMPLE_CODES 现全为 A 股），别改成 sample_*。
  # 🔻 体量实测（prod）：option_contract 7620 行（2026-08-10）；option_daily_snapshot 的
  #    速率**随锚数线性增长**，实测约 580 行/标的/交易日 ——
  #      07-29 ~ 08-06   7 个标的  ≈ 2,100 行/日
  #      08-07          12 个标的    4,789 行
  #      08-10          12 个标的    7,039 行   ← 稳态 ≈ 7,000 行/交易日
  #    ⇒ 全量一年 252 个交易日约 **176 万行**（此处原注释按 2150 行/日估的 54 万，是只覆盖
  #    7 个标的那阵子的量，低估 3.3 倍）；锚涨到 30 个就是 440 万行/年。要重算换算式：
  #    `行/年 ≈ 锚数 × 580 × 252`。
  # 🚨 而本脚本是「截断 → 重灌」全量语义 ⇒ 全量搬会让同步**逐年变慢**。2026-08-11 按上面
  #    那条既定方向落地：不是改回 skip（那等于本地又没数据），而是按 session_date 收窄成
  #    近窗 —— 与 daily_bar 的 sample_or_recent 同形，只是窗口列换成 session_date、天数走
  #    独立的 OPTION_RECENT_DAYS（默认 30 自然日 ≈ 21 交易日 ≈ 14.7 万行，与 daily_bar 现有
  #    16 万行同量级；消费端功能下界只要 2 个 session，取值论证见顶部 OPTION_RECENT_DAYS）。
  # 🚨 父表 option_contract **必须留 full**：近窗只裁快照，快照的 FK 指向合约；按窗口裁父表
  #    会让子表的 FK 断（重灌整事务回滚，表现为「同步全挂」而不是「少几行」）。
  "marketdata.option_contract:full"             # 047 期权合约静态属性（父表，被 option_daily_snapshot FK 引用）
  "marketdata.option_daily_snapshot:recent_sessions" # 047 全链逐日快照（唯一无上限增长表，见上方 🚨）
  # ⚠️ prod 侧当前 **0 行**（2026-08-10 实测）：该维度 enabled + cron 已配 + next_fire_at 已排，
  #    但 sync_run 里 `sync:earnings_event` **一条运行记录都没有** ⇒ 从未跑过。此处翻 full 是
  #    为了「prod 有数据的那天本地自动跟上」，不代表现在能拿到财报打标数据。
  "marketdata.earnings_event:full"           # 047 财报事件日历
  # ── 业务参考数据（非标的级，但有真消费方）────────────────────────────────────────
  # 2026-08-15 由 skip 翻 full（issue #45 附带项）—— 它**不是**运维表，原先跟 sync_run /
  # sync_dimension 归在同一组是分类错了：那几张描述「同步这件事本身」，而交易日历是**业务
  # 参考数据**，仓内至少三处读它 ——
  #   · alert 的交易日闸（`trading-day-gate.ts`：今天非交易日 ⇒ 整条夜间管线 skip）
  #   · optionsdesk 的「最近一个已收盘交易日」（`last-closed-session.ts` ⇒ 陈旧度档）
  #   · marketdata 的 bar 查询
  # 合理推测是写这份注册表时这些消费方还不存在。skip 的代价是**静默失真**而非报错：本地
  # `us` 日历停在 2026-07-15（实测，比当天落后一个月），陈旧度与交易日闸在 dev 上给的都是
  # 另一套答案，而两屏都照常渲染。
  # 🔻 体量约 8.6k 行（cn+hk+us 各约 2.9k，2015 至今），full 的成本可忽略。
  # 📌 与 #45 主修**无依赖**：月度链标已换源到 `option_contract.expiration_cycle`，不再读本表。
  "marketdata.trading_day:full"        # 044 交易日历（三市场 × 2015 至今）
  # 2026-08-22 补登记（062 落 prod 后），直接 full —— 它是上面 trading_day 的**覆盖声明**，
  # 两张必须同进退。真读路径两条、跨两个 context：
  #   · `db-trading-calendar.adapter.ts` classify() / lastClosedSession()
  #     —— 后者 `if (!isWithinCoverage(coverage, cutoff)) return null`，**coverage 行缺失 ⇒ 恒返 null**
  #   · `alert/intraday-eval.processor.ts` 盘中闸（CROSS-CONTEXT-READ，Q7-B per ADR-0052）
  # ⇒ 设 skip 的形态是「trading_day 有 8601 行、覆盖声明却是空的」= 填了但没声明填，陈旧度档与
  #   交易日闸在 dev 上给的是另一套答案，而两屏都照常渲染 —— 与 2026-08-15 trading_day 由 skip
  #   翻 full 那条**同构的静默失真**，且比两张都空更坏。体量 3 行，成本可忽略。
  "marketdata.calendar_coverage:full"  # 062 日历覆盖声明（market 级 PK，无 instrument_id）
  # ── 运维 / 配置表（非标的级，dev 不需要）──────────────────────────────────────────
  "marketdata.calendar_sync_health:skip"     # 044 交易日历填充心跳（市场级 PK，无 instrument_id）
  "marketdata.sync_run:skip"           # 同步运行态，运维表
  "marketdata.sync_dimension:skip"     # 同步维度配置
  "marketdata.sync_dependency:skip"    # 同步依赖拓扑
  "marketdata.sync_blacklist:skip"     # 同步黑名单
  # 2026-08-22 补登记（060 落 prod 后）。归这一组而非业务组：server 侧**只写不读** ——
  # `anchor-cold-start.usecase.ts` 的 finish() 一处覆盖式单行 upsert（PK=anchorId，FR-026 只留
  # 最近一次），全仓零读路径。它记的是「**这台库上**冷启动跑过没有、结局如何」= dev 自己的事实；
  # 搬 prod 的进来等于给 dev 编一份它没跑过的运行史。与 sync_run / calendar_sync_health 同族。
  "marketdata.anchor_cold_start_run:skip"    # 060 锚冷启动补齐运行记录（无 instrument_id，无 FK）
  # ── optionsdesk：锚（045）—— 期权台一切的入口，无锚则雷达/详情/聚合三屏全是空态 ──────
  # 两张都 full 且**都切不出样本**（anchor 无 instrument_id，主键是 canonical ticker 字符串）。
  # 体量恒定在十几行量级（锚是人工维护的白名单，2026-08-10 prod = 12 / 12）。
  # 🚨 覆盖本地手工造的锚：本脚本是「截断 → 重灌」，跑完本地 anchor 就等于 prod 的那份。
  #    要在本地留自造锚做实验，得先把这两行改回 skip。
  "optionsdesk.anchor:full"                  # 045 愿买价锚（V / confidence / L 层 / excluded / 水位手选）
  "optionsdesk.anchor_change:full"           # 045 锚变更审计流水（无 FK，纯 anchor_id 引用）
  # 2026-08-22 补登记（059 落 prod 后）。⚠️ 与同组两张不同，这张是 **skip**，两条理由：
  # ① 无失真风险：server 侧只 create 不读（`submit-anchor-from-guest.usecase.ts`，controller 只
  #    回显刚写那行）⇒ dev 恒空不会让任何一处答错；
  # ② full 有**真代价**：本脚本截断→重灌，会抹掉本地自己投的测试提交 —— 而本地联调 059 访客
  #    投递流程要看的正是刚投那条。
  # 将来出现审核队列 / 列表读路径（那时 dev 空表 = 屏永远空）再翻 full。
  "optionsdesk.anchor_submission:skip"       # 059 访客估值投递待审表（prod 131 行 @2026-08-22）
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

# 非致命告警（趋势 / 部署漂移这类「数据是对的，但你该处理一下」）：进日志 + 桌面通知，
# **并在结尾汇总里重放一次**。重放不是啰嗦：飞书那条 report 由 nvy-run-reported 取合并输出的
# 末 20 行组装，而本脚本光导出循环就打十几行 ——「中途打的那行会被顶出 tail 窗口」= 告警在
# 飞书里看不见 = 等于没告警。
WARN_COUNT=0
WARN_LOG=""
warn() {
  WARN_COUNT=$((WARN_COUNT + 1))
  WARN_LOG="${WARN_LOG}${WARN_LOG:+$'\n'}   · $1"
  notify "⚠️ $1"
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
    # 近窗按**自然日**切，口径落在 **prod PG 会话**上（CURRENT_DATE 用 prod 的会话时区求值）：
    # 导出与 §4 对数用的是同一条 WHERE、同一个 prod 会话 ⇒ 两侧恒一致，边界差一天也不会误报。
    # 刻意不接交易日历（daily_bar 那种 distinct trade_date 取第 N 个）：那是给「近 N 个交易日」
    # 用的，而这里的消费下界只有 2 个 session，30 天窗口下差一天对任何消费者都无感知，
    # 不值得为它把 optionsdesk 的近窗绑到 marketdata.daily_bar 的交易日集合上。
    recent_sessions) echo "WHERE session_date >= CURRENT_DATE - INTERVAL '$OPTION_RECENT_DAYS days'" ;;
    *) return 1 ;;
  esac
}

# 文件 → sha256。**读不到 / 无工具 → 空串（且退出 0）**，不是错：launchd 对 ~/Documents 无
# TCC，读仓内源被拒是常态；这里若让它非零，ERR trap 会把「我看不见对面」升级成「同步失败」。
# 🚨 `|| true` 不可省 —— 本脚本开着 pipefail，光靠 awk 收尾兜不住左侧的非零（读不到时 shasum
#    退 1，pipefail 会把整条管道判成失败，于是 ERR trap 当场 fail）。
file_sha256() {
  if command -v shasum >/dev/null 2>&1; then
    { shasum -a 256 "$1" 2>/dev/null || true; } | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    { sha256sum "$1" 2>/dev/null || true; } | awk '{print $1}'
  fi
}

# 部署印记取值（deployed.meta 是 `键=值` 行，值可含 `=`）。文件/键缺失 → 空串。
# 刻意 awk 取值而非 source —— 那份文件在 ~/.nvy 下，不该拿它当可执行内容。
stamp_get() {
  [ -r "$DEPLOY_STAMP" ] || return 0
  awk -F= -v k="$1" '$1 == k { sub(/^[^=]*=/, ""); print; exit }' "$DEPLOY_STAMP"
}

# 漂移判定（纯函数）：两侧 hash → same / drift / unreadable。
# 🚨 「有一侧算不出 hash」必须判成 unreadable 而不是 drift —— 看不见对面 ≠ 对面变了，
#    误报会让人学会忽略这条告警，而这条告警的全部价值就在于它平时不响。
drift_verdict() {
  if [ -z "${1:-}" ] || [ -z "${2:-}" ]; then
    echo unreadable
  elif [ "$1" = "$2" ]; then
    echo same
  else
    echo drift
  fi
}

# ─── 部署漂移自检（先于一切干活：跑的这份，是不是仓内那份？）──────────────────────
# 2026-08-11 实撞：仓内 sync.sh 08-10 已把三张美股期权表由 skip 翻 full，但**没重跑 setup.sh**
# ⇒ 09:05 实际执行的 ~/.nvy 副本还是 08-09 的旧版。日志照常打「✅ 同步完成」、launchctl 退出码
# 0、逐表对数全绿 —— 因为对数比的是「旧版声明要同步的那些表」。**漂移的失败形态是「静默的
# 成功」**，少同步三张表这件事存在了两天没人发现。
#
# 检法按「这一侧读得到什么」分两臂 —— TCC 决定了没有单一形态能覆盖两边：
#   • 部署态（从 ~/.nvy 跑，launchd 走这条）：与 setup 烙进 deployed.meta 的 hash 比对自身，
#     再**尝试**读烙印里记的仓内源路径。读得到就直接比出漂移；读不到（launchd 对 ~/Documents
#     无 TCC，这是常态）就退化成把「烙印 commit + 部署天龄」打进本轮汇总，让漂移在每日飞书
#     report 里肉眼可见，并在天龄超 DEPLOY_STALE_DAYS 时告警 —— 天龄是无 TCC 下唯一还观测得到
#     的**代理量**，不是真相：它只说明「很久没重新部署过」，不说明仓内确实变了。
#   • 开发态（从仓内直跑，交互 shell 有 TCC）：拿自己与 ~/.nvy 副本比。改完脚本手动跑一次就会
#     当场喊「副本还是旧版」—— 上面那次事故正是被这一臂正面命中的形态（改完必然会手动验一次）。
# 🚫 一律 warn 不 fail：漂移时旧逻辑通常仍能跑出**部分**数据，硬失败等于把「少三张表」升级成
#    「一张表都没有」，方向反了。
DEPLOY_DIR="$HOME/.nvy/marketdata-dev-sync"
DEPLOY_COPY="$DEPLOY_DIR/sync.sh"
DEPLOY_STAMP="$DEPLOY_DIR/deployed.meta" # setup.sh 生成：src / sha256 / commit / deployed_at_epoch
DEPLOY_STALE_DAYS="${DEPLOY_STALE_DAYS:-14}"
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELF_PATH="$SELF_DIR/$(basename "${BASH_SOURCE[0]}")"
DEPLOY_NOTE=""
self_hash="$(file_sha256 "$SELF_PATH")"

if [ "$SELF_DIR" = "$DEPLOY_DIR" ]; then
  if [ ! -r "$DEPLOY_STAMP" ]; then
    warn "副本没有部署印记 deployed.meta（旧版 setup 装的）—— 判不出与仓内是否一致，跑一次 pnpm dev-marketdata:setup 补上"
  else
    stamped_hash="$(stamp_get sha256)"
    stamped_commit="$(stamp_get commit)"
    stamped_src="$(stamp_get src)"
    stamped_at="$(stamp_get deployed_at_epoch)"
    age_days=-1
    case "$stamped_at" in
      '' | *[!0-9]*) : ;; # 印记坏了就别算天龄，-1 天永远不触发下面的阈值
      *) age_days=$((($(date +%s) - stamped_at) / 86400)) ;;
    esac
    DEPLOY_NOTE="副本 commit=${stamped_commit:-?}，部署于 ${age_days} 天前"
    if [ "$(drift_verdict "$self_hash" "$stamped_hash")" = drift ]; then
      warn "副本内容与自己的部署印记不符（有人手改了 ${DEPLOY_COPY}，或上次 setup 拷到一半）—— 重跑 pnpm dev-marketdata:setup"
    fi
    src_hash=""
    if [ -n "$stamped_src" ] && [ -r "$stamped_src" ]; then src_hash="$(file_sha256 "$stamped_src")"; fi
    case "$(drift_verdict "$self_hash" "$src_hash")" in
      drift)
        warn "副本落后于仓内 sync.sh（印记 commit=${stamped_commit:-?}，${age_days} 天前部署）—— 定时任务跑的是旧逻辑，重跑 pnpm dev-marketdata:setup" ;;
      same) : ;;
      *)
        echo "  ℹ️ 读不到仓内源（${stamped_src:-印记未记路径}）—— launchd 对 ~/Documents 无 TCC，跳过与仓内比对，改看天龄"
        if [ "$age_days" -ge "$DEPLOY_STALE_DAYS" ]; then
          warn "副本已 ${age_days} 天没重新部署（阈值 ${DEPLOY_STALE_DAYS} 天）—— 期间仓内 sync.sh 若改过，跑的就是旧逻辑；确认一下或直接重跑 pnpm dev-marketdata:setup"
        fi ;;
    esac
  fi
else
  copy_hash=""
  if [ -r "$DEPLOY_COPY" ]; then copy_hash="$(file_sha256 "$DEPLOY_COPY")"; fi
  if [ -z "$copy_hash" ]; then
    DEPLOY_NOTE="仓内直跑（本机未装定时任务）"
  else
    DEPLOY_NOTE="仓内直跑"
    if [ "$(drift_verdict "$self_hash" "$copy_hash")" = drift ]; then
      warn "仓内 sync.sh 与部署副本 ${DEPLOY_COPY} 不一致 —— 每日定时任务跑的仍是旧版（正是 2026-08-11 那次「静默的成功」），重跑 pnpm dev-marketdata:setup"
    fi
  fi
fi

# ─── 0. 保险拉起本地 dev stack（晨间无人值守；日常收工 teardown 的 `compose down` 会
#        移除容器，`docker start` 救不回被移除的容器，故优先 `compose up` 重建）──────────
notify "▶ 开始同步（样本 ${#SAMPLE_CODES[@]} 支，近窗 ${RECENT_DAYS} 交易日，期权快照近 ${OPTION_RECENT_DAYS} 天；${DEPLOY_NOTE:-部署态未知}）"
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
    || fail "检测到未注册的新表 $t — 请在 TABLE_POLICIES 声明同步策略（full/sample_or_recent/sample_only/recent_sessions/skip）"
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
  # 单表体量趋势闸（2026-08-11 加）：**只 warn 不 fail** —— 表大不是正确性问题，是「截断重灌
  # 的同步会越来越慢」的早期信号，硬失败等于本地天天没数据，代价方向反了。
  # 阈值 30 万行的取法（两头夹）：现存最大表 daily_bar 实测约 17 万（全股近 20 交易日 + 样本股
  # 全史），取其约 1.8 倍 ⇒ 日常零噪声、不会天天喊；而 option_daily_snapshot 在 30 天窗口下
  # 约 24 个锚就触线（24 锚 × 21 交易日 × 580 行/锚/日 ≈ 29 万），**早于**「30 锚 ≈ 37 万行」
  # 那个体量点，留出处置窗口（调小 OPTION_RECENT_DAYS，或给该表换增量语义）。
  case "$exp_n" in
    '' | *[!0-9]*) : ;; # 非数字（上面已判空，这里纯防御）→ 不判阈值
    *)
      if [ "$exp_n" -gt "$ROW_WARN_THRESHOLD" ]; then
        warn "表 ${t} 单表 ${exp_n} 行，已过阈值 ${ROW_WARN_THRESHOLD}（趋势预警，本轮数据不受影响）—— 收窄它的近窗或调 ROW_WARN_THRESHOLD"
      fi ;;
  esac
  prod_copy "SELECT $cols FROM $t $where ORDER BY 1" "$TMP_DIR/$t.csv"
  echo "  导出 $t: $(wc -l <"$TMP_DIR/$t.csv" | tr -d ' ') 行（$(printf '%s' "$cols" | awk -F, '{print NF}') 列）"
  SYNCED_TABLES+=("$t")
done

# ─── 3. 截断 → 重灌 → 重置序列（单事务原子；失败回滚保旧数据）─────────────────
# SQL 动态生成：TRUNCATE 全部同步表（RESTART IDENTITY CASCADE）→ 逐表 \copy（显式有序列名，
# 按名对齐）→ 逐表 setval（**无 `id` 列的表整条不生成**，见下方循环里的判据）。
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
  # 🚨 **无 `id` 列的表整条 setval 不生成**，🚫 不能只靠 `WHERE s.seq IS NOT NULL` 兜：
  #    `(SELECT max(id) FROM $t)` 这个子查询在**解析期**就要解析 `id`，表里没这一列 ⇒ 整条
  #    语句 parse error ⇒ 事务回滚 ⇒ 整轮同步失败。外层 WHERE 是运行期的，救不了解析期。
  #    2026-08-15 实撞：`marketdata.trading_day` 翻 full 当轮即 `ERROR: column "id" does not
  #    exist`（它的主键是复合 `(market, date)`，没有 `id`）。
  #    判据走 prod 派生的列清单（与 \copy 用的是同一份），不另查一次 information_schema。
  case ",$(cols_for "$t")," in
    *,id,*) ;;
    *) continue ;;
  esac
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
# 告警重放（见 warn 的注释：中途那行会被导出日志顶出飞书 report 的 tail 窗口）
if [ "$WARN_COUNT" -gt 0 ]; then
  printf '⚠️ 本轮 %d 条告警（数据本身已对数通过，但需要处理）：\n%s\n' "$WARN_COUNT" "$WARN_LOG"
fi
notify "✅ 同步完成（逐表已与 prod 对数）：${parts}（样本 ${hit_count} 支全历史 + 全股近 ${RECENT_DAYS} 日 + 期权快照近 ${OPTION_RECENT_DAYS} 天；${DEPLOY_NOTE:-部署态未知}；告警 ${WARN_COUNT} 条）"
