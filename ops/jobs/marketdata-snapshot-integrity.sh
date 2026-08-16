#!/usr/bin/env bash
#
# marketdata-snapshot-integrity.sh — 期权快照**逐合约完整性**探针（047 T025a）。**零逻辑胶水，判断不在这里。**
#
# 🚨🚨 动本文件前先读完本段，它是宪法 §II 合规链条的最后一环（范式同 marketdata-table-health）。
#
# 仓内无 bash 测试框架 → 本脚本无法 RED-first，直接撞宪法 §II（NON-NEGOTIABLE）。裁决 =
# **把 bash 压到零逻辑**：所有判断下沉到 `marketdata-snapshot-integrity.sql`（同目录兄弟），该谓词在
# Testcontainers IT 里被真测（`apps/server/test/integration/marketdata.snapshot-integrity.it.spec.ts`，
# 其中还把它与 TS 侧 `option-snapshot-coverage.check.ts` 的逐票结论钉在一起）。
# 本脚本只剩三步：**跑谓词 → 打印 summary → exit 谓词给的码**。
#
#   ⇒ 🚨 **本文件里不得出现任何 if / 阈值 / 比较 / 日期算术**。每写一行判断，就是塞回一份没有
#     测试覆盖的逻辑，「判断已被真测」当场变成假话。要改判据 → 改 `marketdata-snapshot-integrity.sql`。
#   ⇒ 🚨 **禁止**在本文件内联复制谓词 SQL：两份必 drift，drift 即 §II 合规名存实亡。
#
# 它为什么存在（FR-046 的**唯一**载体，判据全在谓词里，此处仅复述供人读）：
#   FR-046 明写「完整性 ERROR 的触达 MUST NOT 并入次日日报」。次日日报 = 次晨 09:00 的
#   `marketdata-sync-report` 读 `sync_run` —— 它晚一天，而期权快照**漏采即永久缺口**
#   （vendor 不提供历史交易日的期权快照）；更要命的是 T021 的判定跑在**采集进程内**，app 整个
#   挂掉时数据自然缺失、判定本身也没跑 ⇒ 最需要告警的故障恰好最静默（044 病灶形状）。
#   ⇒ 本探针**不经 app 进程**直读 PG，独立 timer 在当晚采集窗结束后触发。
#
# **不经 app 进程**（结构性要求，FR-051）：通路同 marketdata-table-health 只读取证 ——
# docker exec -i <pg> psql（纯 SELECT，无写路径）。
#
# 退出码：0 = 完整 / ET 周末不判（都是谓词给的，非本脚本判的）/ **非零 = 需要人看**，两类合流且有意不区分：
#   · 1        = 谓词判某票覆盖率跌破阈值
#   · 任意非零 = 探针自身故障（psql 连不上 / 谓词 SQL 报错 / 谓词文件缺失；均由 `set -e` 非零
#                终止，psql/docker 的 stderr 直接进 journal 供定位）
# **探针故障也必须告警**：探不动 ≠ 完整。沉默被读成正常正是 044 事故的病灶形状。
#
# 🚨 为什么 `set -e` 而不是 `if [ "$rc" -ne 0 ]` 兜 psql 失败：**那是个分支**。用 `set -e` 让
# 失败自己非零终止 → 同等健壮、零分支，守住上面那条铁律。
#
# 飞书推送由外层 `nvy-run-reported` wrapper 据退出码统一推（webhook/签名在 feishu-send.sh），
# 本脚本零飞书 I/O —— 满足「新增调度复用既有飞书基建」（scheduled-tasks.md 新增 checklist 2）。
#
# Config — 可选 EnvironmentFile（仅接线，不含任何判据）：
#   SYNC_REPORT_PG_CONTAINER  postgres 容器（默认 nvy-tight-postgres-1 = prod）
#   SYNC_REPORT_PG_USER / _DB psql -U / -d（默认 mbw / mbw）
#     ↑ **与 marketdata-sync-report / marketdata-table-health 共用同一套变量名**：同一个 prod PG，
#       多套名字 = 多份会漂移。
#   SNAPSHOT_INTEGRITY_PREDICATE_SQL  谓词路径（默认 = 本脚本同目录 marketdata-snapshot-integrity.sql）
set -euo pipefail

PG_CONTAINER="${SYNC_REPORT_PG_CONTAINER:-nvy-tight-postgres-1}"
PG_USER="${SYNC_REPORT_PG_USER:-mbw}"
PG_DB="${SYNC_REPORT_PG_DB:-mbw}"
# 🚨 谓词是**同目录同名兄弟**（`<unit>.sh` ↔ `<unit>.sql`），仓内与装机后一致：
# 仓 ops/jobs/ ↔ 机 /usr/local/lib/nvy/jobs/。拆开放 = 每日一条「谓词文件缺失」假红。
PREDICATE_SQL="${SNAPSHOT_INTEGRITY_PREDICATE_SQL:-$(dirname "${BASH_SOURCE[0]}")/marketdata-snapshot-integrity.sql}"

# 谓词自包含无参数（阈值 / 「当日」的时区 / ET 周末闸 / 到期判据全写死在 SQL 内）→ 这里无任何
# -v 传参、也不设任何 GUC：传参 = 把判断挪回 bash = 前功尽弃。
#   ⚠️ 谓词里那个 `current_setting('nvy.current_day', true)` **只给 IT 钉死日期用**，本脚本恒不设
#     它 ⇒ 生产恒走 `now() AT TIME ZONE 'America/New_York'`。**别把它接成 EnvironmentFile 里的
#     开关** —— 那等于给探针装了个静音钮（论证见 .sql 文件头）。
# 契约（由 IT 断言锁死）：恒返单行两列 `exit_code<TAB>summary`，summary 无 tab/换行。
verdict_row="$(docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" \
  -X -q -At -F $'\t' -v ON_ERROR_STOP=1 -f - < "$PREDICATE_SQL")"

IFS=$'\t' read -r exit_code summary <<<"$verdict_row"

printf '%s\n' "$summary"
exit "$exit_code"
