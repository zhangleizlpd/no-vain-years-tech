#!/usr/bin/env bash
#
# marketdata-calendar-health.sh — 交易日历健康探针（044 US3 心跳档 + 062 US4 视野档）。**零逻辑胶水，判断不在这里。**
#
# 🚨🚨 动本文件前先读完本段，它是宪法 §II 合规链条的最后一环。
#
# 仓内无 bash 测试框架 → 本脚本无法 RED-first，直接撞宪法 §II（NON-NEGOTIABLE）。
# 裁决（analyze A2 → user 2026-07-16）= **把 bash 压到零逻辑**：所有判断下沉到
# `marketdata-calendar-health.sql`（同目录兄弟），该谓词在 Testcontainers IT 里被真测
# （`marketdata.calendar-044.health.it.spec.ts` 真测**心跳档**：埋 25h/27h 心跳 + 主源/降级
# servedBy；`marketdata.calendar-062.horizon-probe.it.spec.ts` 真测**视野档**：埋余量 2/8 个
# 交易日、年末终点、跨年旧年末、声明缺失）。本脚本只剩三步：**跑谓词 → 打印 summary → exit 谓词给的码**。
#
#   ⇒ 🚨 **本文件里不得出现任何 if / 阈值 / 比较 / 市场清单 / 「主源是谁」/「几个交易日算够」**。
#     每写一行判断，就是塞回一份没有测试覆盖的逻辑，「判断已被真测」当场变成假话。
#     要改判据 → 改 `marketdata-calendar-health.sql`（那里有 IT 兜着），**不改这里**。
#   ⇒ 🚨 **禁止**在本文件内联复制谓词 SQL：两份必 drift，drift 即 §II 合规名存实亡。
#
# 判据（**全在谓词里**，此处仅复述供人读，非本脚本行为）：
#   · 心跳档（liveness，「填充还活着吗」）：cn / hk / us 任一 `last_success_at` 超 26h（或缺行）
#     → 不健康；或任一 `served_by` 非**该市场的**主源（cn/hk=tencent、us=futu）→ 降级亦不健康
#     （FR-014「降级 ≠ 健康」）。us 于 2026-07-31 随换源纳入监控面（044 原「us 有意排除」的理由
#     = 无备源可用，已被 `us: [富途 L1, 腾讯 L2]` 两活源推翻）。
#   · 视野档（coverage，「视野还在往前走吗」，062 FR-016）：`calendar_coverage` 缺行 → 最重一档；
#     `covered_to` 早于今天 → 视野落后；今天之后到 `covered_to` 之间的交易日数 < 5 且 `covered_to`
#     未抵**当年** 12-31 → 视野过近。
#   🚨🚨 年末豁免只在**当年**成立：1 月 1 日起旧年末的终点会落进「视野落后」档而转红，**这是设计**
#     （年历没更就该响）。🚫 MUST NOT 把豁免延到次年、🚫 MUST NOT 加「1 月宽限期」—— 那等于把唯一
#     会响的信号关掉，而年更漏跑的后果是整年日历失真。完整论证在 .sql 头部。
#   🚨 两档**并存且不互相替代**（FR-017）：填充可以每晚成功而视野一天都不往前走，反之亦然。
#
# **不经 app 进程**（FR-010 的结构性要求）：直读 PG —— app 整个挂掉、心跳自然陈旧 → 照样告警。
# 通路同 marketdata-sync-report.sh 只读取证：docker exec -i <pg> psql -U <user> -d <db>（纯 SELECT，无写路径）。
#
# 退出码：0 = 健康（谓词给的，非本脚本判的）/ **非零 = 需要人看**，两类合流且有意不区分：
#   · 1        = 谓词判不健康（陈旧 / 降级 / 无覆盖声明 / 视野落后 / 视野过近）
#   · 任意非零 = 探针自身故障（psql 连不上 → 1 / 谓词 SQL 报错 → 3 / 谓词文件缺失 → 1；
#                均由 `set -e` 非零终止，psql/docker 的 stderr 直接进 journal 供定位）
# **探针故障也必须告警**：探不动 ≠ 健康。沉默被读成正常正是 044 事故的病灶形状，不在这里重演。
#
# 🚨 为什么 `set -e` 而不是 marketdata-sync-report.sh 那样 `if [ "$rc" -ne 0 ]` 兜 psql 失败：**那是个分支**。
# 用 `set -e` 让失败自己非零终止 → 同等健壮、零分支，守住上面那条铁律。
#
# 飞书推送由外层 `nvy-run-reported` wrapper 据退出码统一推（webhook/签名在 feishu-send.sh），
# 本脚本零飞书 I/O —— 满足「新增调度复用既有飞书基建」（scheduled-tasks.md 新增 checklist 2）。
#
# Config — 可选 EnvironmentFile（仅接线，不含任何判据）：
#   SYNC_REPORT_PG_CONTAINER  postgres 容器（默认 nvy-tight-postgres-1 = prod）
#   SYNC_REPORT_PG_USER / _DB psql -U / -d（默认 mbw / mbw）
#     ↑ **与 marketdata-sync-report 共用同一套变量名**：同一个 prod PG，两套名字 = 两份会漂移。
#   CALENDAR_HEALTH_PREDICATE_SQL  谓词路径（默认 = 本脚本同目录 marketdata-calendar-health.sql）
set -euo pipefail

PG_CONTAINER="${SYNC_REPORT_PG_CONTAINER:-nvy-tight-postgres-1}"
PG_USER="${SYNC_REPORT_PG_USER:-mbw}"
PG_DB="${SYNC_REPORT_PG_DB:-mbw}"
# 🚨 谓词是**同目录同名兄弟**（`<unit>.sh` ↔ `<unit>.sql`），仓内与装机后一致：
# 仓 ops/jobs/ ↔ 机 /usr/local/lib/nvy/jobs/。拆开放 = 每 4h 一条「谓词文件缺失」假红。
PREDICATE_SQL="${CALENDAR_HEALTH_PREDICATE_SQL:-$(dirname "${BASH_SOURCE[0]}")/marketdata-calendar-health.sql}"

# 谓词自包含无参数（阈值/市场清单/主源名写死在 SQL 内）→ 这里无任何 -v 传参：
# 传参 = 把判断挪回 bash = 前功尽弃。
# 契约（由 IT 断言锁死）：恒返单行两列 `exit_code<TAB>summary`，summary 无 tab/换行。
verdict_row="$(docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" \
  -X -q -At -F $'\t' -v ON_ERROR_STOP=1 -f - < "$PREDICATE_SQL")"

IFS=$'\t' read -r exit_code summary <<<"$verdict_row"

printf '%s\n' "$summary"
exit "$exit_code"
