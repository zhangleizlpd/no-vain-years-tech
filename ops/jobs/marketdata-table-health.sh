#!/usr/bin/env bash
#
# marketdata-table-health.sh — marketdata 表级数据健康探针。**零逻辑胶水，判断不在这里。**
#
# 🚨🚨 动本文件前先读完本段，它是宪法 §II 合规链条的最后一环。
#
# 仓内无 bash 测试框架 → 本脚本无法 RED-first，直接撞宪法 §II（NON-NEGOTIABLE）。沿用 044
# 探针的裁决 = **把 bash 压到零逻辑**：所有判断下沉到 `marketdata-table-health.sql`（同目录兄弟），
# 该谓词在 Testcontainers IT 里被真测（`apps/server/test/integration/marketdata.table-health.it.spec.ts`：
# 17 条用例，其中 13 条是**注入故障要求翻红**的变异用例）。本脚本只剩三步：
# **跑谓词 → 打印 summary → exit 谓词给的码**。
#
#   ⇒ 🚨 **本文件里不得出现任何 if / 阈值 / 比较 / 哨兵清单 / 「几天算陈旧」**。
#     每写一行判断，就是塞回一份没有测试覆盖的逻辑，「判断已被真测」当场变成假话。
#     要改判据 → 改 `marketdata-table-health.sql`（那里有 IT 兜着），**不改这里**。
#   ⇒ 🚨 **禁止**在本文件内联复制谓词 SQL：两份必 drift，drift 即 §II 合规名存实亡。
#
# 它为什么存在（判据全在谓词里，此处仅复述供人读，非本脚本行为）：
#   2026-08-01 四个维度在 prod 静默丢数、`SyncRun` 连续十几天全绿无人发现（announcement 停 12 个
#   交易日 / buyback 同期零增量 / shareholder_change 一周只采 1/7 / fund_holding 上线 18 天 0 行）。
#   既有防线全部漏判：alertIfDegraded 只看 failed、FreshnessSlaCheck 量的是 **run 年龄**而非
#   **数据年龄**、rowsFetched 全仓只有一处埋点。⇒ 判据必须挂在**数据**上、跑在**采集进程之外**。
#
# **不经 app 进程**（结构性要求，同 044）：直读 PG —— app 整个挂掉、数据自然陈旧 → 照样告警。
# 通路同 marketdata-calendar-health 只读取证：docker exec -i <pg> psql（纯 SELECT，无写路径）。
#
# 退出码：0 = 健康（谓词给的，非本脚本判的）/ **非零 = 需要人看**，两类合流且有意不区分：
#   · 1        = 谓词判不健康（哨兵陈旧 / us 掉队 / 空工作集 / 日历缺失 / 047 期权到期阶梯截断 /
#                期权快照掉队 / 财报视野塌陷 / 磁盘水位不足 90 天扩容窗）
#   · 任意非零 = 探针自身故障（psql 连不上 / 谓词 SQL 报错 / 谓词文件缺失；均由 `set -e` 非零终止，
#                psql/docker 的 stderr 直接进 journal 供定位）
# **探针故障也必须告警**：探不动 ≠ 健康。沉默被读成正常正是 044 事故的病灶形状。
#
# 🚨 为什么 `set -e` 而不是 `if [ "$rc" -ne 0 ]` 兜 psql 失败：**那是个分支**。用 `set -e` 让失败
# 自己非零终止 → 同等健壮、零分支，守住上面那条铁律。
#
# 飞书推送由外层 `nvy-run-reported` wrapper 据退出码统一推（webhook/签名在 feishu-send.sh），
# 本脚本零飞书 I/O —— 满足「新增调度复用既有飞书基建」（scheduled-tasks.md 新增 checklist 2）。
#
# Config — 可选 EnvironmentFile（仅接线，不含任何判据）：
#   SYNC_REPORT_PG_CONTAINER  postgres 容器（默认 nvy-tight-postgres-1 = prod）
#   SYNC_REPORT_PG_USER / _DB psql -U / -d（默认 mbw / mbw）
#     ↑ **与 marketdata-sync-report / marketdata-calendar-health 共用同一套变量名**：同一个 prod PG，
#       三套名字 = 三份会漂移。
#   TABLE_HEALTH_PREDICATE_SQL  谓词路径（默认 = 本脚本同目录 marketdata-table-health.sql）
set -euo pipefail

PG_CONTAINER="${SYNC_REPORT_PG_CONTAINER:-nvy-tight-postgres-1}"
PG_USER="${SYNC_REPORT_PG_USER:-mbw}"
PG_DB="${SYNC_REPORT_PG_DB:-mbw}"
# 🚨 谓词是**同目录同名兄弟**（`<unit>.sh` ↔ `<unit>.sql`），仓内与装机后一致：
# 仓 ops/jobs/ ↔ 机 /usr/local/lib/nvy/jobs/。拆开放 = 每 4h 一条「谓词文件缺失」假红。
PREDICATE_SQL="${TABLE_HEALTH_PREDICATE_SQL:-$(dirname "${BASH_SOURCE[0]}")/marketdata-table-health.sql}"

# PG 数据卷的**可用 KB**（047 FR-052a 磁盘水位判据的唯一输入）。
#
# 🚨 为什么这一行不违反上面那条铁律：它传的是**观测值不是判断** —— PostgreSQL 没有任何读
#    文件系统剩余空间的内建能力，这个数只能由 OS 侧量。阈值（90 天扩容窗）、日均增长的算法、
#    「样本不足不告警」全部仍在谓词里，本文件依旧零 if / 零阈值 / 零比较。
#    好处是这条判据**反而成了最好测的一条**：IT 直接注入低余量即可要求翻红。
# `sh -c` 里用容器自己的 $PGDATA（宿主不必知道镜像的数据目录在哪）；`df -P` 保证单行输出、
# `NR==2 {print $4}` 取 Available 列。取不到 → 空串 → psql 语法错 → 下面 set -e 非零终止（告警），
# **不静默放行**。awk 只是取列，不含任何判断。
avail_kb="$(docker exec "$PG_CONTAINER" sh -c 'df -Pk "$PGDATA"' | awk 'NR==2 {print $4}')"

# 阈值/哨兵清单/市场全部写死在 SQL 内 → 这里**只传上面那一个观测值**，不传任何判断参数：
# 传判断 = 把逻辑挪回 bash = 前功尽弃。
# 契约（由 IT 断言锁死）：恒返单行两列 `exit_code<TAB>summary`，summary 无 tab/换行。
verdict_row="$(docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" \
  -X -q -At -F $'\t' -v ON_ERROR_STOP=1 -v avail_kb="$avail_kb" -f - < "$PREDICATE_SQL")"

IFS=$'\t' read -r exit_code summary <<<"$verdict_row"

printf '%s\n' "$summary"
exit "$exit_code"
