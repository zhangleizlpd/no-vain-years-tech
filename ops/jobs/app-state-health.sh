#!/usr/bin/env bash
#
# app-state-health.sh — 非 marketdata 侧的应用状态健康探针。**零逻辑胶水，判断不在这里。**
#
# 🚨🚨 动本文件前先读完本段，它是宪法 §II 合规链条的最后一环。
#
# 仓内无 bash 测试框架 → 本脚本无法 RED-first，直接撞宪法 §II（NON-NEGOTIABLE）。沿用 044 /
# table-health 的裁决 = **把 bash 压到零逻辑**：所有判断下沉到 `app-state-health.sql`（同目录
# 兄弟），该谓词在 Testcontainers IT 里被真测（`apps/server/test/integration/app-state-health.it.spec.ts`：
# 9 条用例，其中 5 条是**注入故障要求翻红**的变异用例）。本脚本只剩三步：
# **跑谓词 → 打印 summary → exit 谓词给的码**。
#
#   ⇒ 🚨 **本文件里不得出现任何 if / 阈值 / 比较 / 市场清单 / 「几天算陈旧」**。
#     每写一行判断，就是塞回一份没有测试覆盖的逻辑，「判断已被真测」当场变成假话。
#     要改判据 → 改 `app-state-health.sql`，**不改这里**。
#   ⇒ 🚨 **禁止**在本文件内联复制谓词 SQL：两份必 drift。
#
# 它为什么存在（判据全在谓词里，此处仅复述供人读）：
#   #209 排查（2026-08-27）发现三个既有数据探针的谓词**全部只碰 `marketdata` schema` ⇒
#   `optionsdesk` / `alert` / `public.outbox_event` 等**零进程外监控**。而
#   `optionsdesk/sync-anchor-quote.scheduler.ts` 的失败路径是 `catch → logger.error → return null`，
#   **不落 `sync_run`**（不在 marketdata 同步框架内）⇒ 纯真空：日志没有接收端，数据侧也没人看。
#
# **不经 app 进程**（结构性要求，同 044 / table-health）：直读 PG —— app 整个挂掉、数据自然陈旧
# → 照样告警。通路同其余只读探针：docker exec -i <pg> psql（纯 SELECT，无写路径）。
#
# 退出码：0 = 健康（谓词给的，非本脚本判的）/ **非零 = 需要人看**，两类合流且有意不区分：
#   · 1        = 谓词判不健康（锚收盘价整体停摆 / 空工作集 / 日历缺失 / outbox relay 停摆）
#   · 任意非零 = 探针自身故障（psql 连不上 / 谓词 SQL 报错 / 谓词文件缺失；均由 `set -e` 非零
#                终止，psql/docker 的 stderr 直接进 journal 供定位）
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
#     ↑ **与其余探针共用同一套变量名**：同一个 prod PG，多套名字 = 多份会漂。
set -euo pipefail

PG_CONTAINER="${SYNC_REPORT_PG_CONTAINER:-nvy-tight-postgres-1}"
PG_USER="${SYNC_REPORT_PG_USER:-mbw}"
PG_DB="${SYNC_REPORT_PG_DB:-mbw}"
# 🚨 谓词是**同目录同名兄弟**（`<unit>.sh` ↔ `<unit>.sql`），仓内与装机后一致：
# 仓 ops/jobs/ ↔ 机 /usr/local/lib/nvy/jobs/。拆开放 = 每 4h 一条「谓词文件缺失」假红。
# **蓄意不给 env 覆盖口**：sync-report 头部记着路径知识分散两处的代价，别再长新拐杖。
PREDICATE_SQL="$(dirname "${BASH_SOURCE[0]}")/app-state-health.sql"

# 契约（由 IT 断言锁死）：恒返单行两列 `exit_code<TAB>summary`，summary 无 tab/换行。
# 自包含无参数（阈值写死在 SQL 内）→ 无 -v 传参：传判断参数 = 把逻辑挪回 bash = 前功尽弃。
verdict_row="$(docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" \
  -X -q -At -F $'\t' -v ON_ERROR_STOP=1 -f - < "$PREDICATE_SQL")"

IFS=$'\t' read -r exit_code summary <<<"$verdict_row"

printf '%s\n' "$summary"
exit "$exit_code"
