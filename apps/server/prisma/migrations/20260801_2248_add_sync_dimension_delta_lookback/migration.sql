-- delta 回看窗声明式化 (expand-only —— 仅 ADD COLUMN 可空 + seed UPDATE, 无破坏性变更,
-- 单 PR 合规 per .claude/rules/migration-rules.md §2)。
--
-- 背景 (2026-08-01 prod 只读取证, 四个维度正在静默丢数据、SyncRun 全绿):
--   · announcement       停在 07-15, 12 个交易日零增量  —— 端点 endDate **右开**, 精确当日窗 = 空区间
--   · buyback            停在 07-15, vendor 侧 hk:01810 有 5 笔未采 —— T+1 披露 + 精确当日窗
--   · shareholder_change 停在 07-20, 9 只样本票逐票漏 1~11 天 —— 周更 cron + 精确当日窗 = 只采 1/7
--   · allotment          机制同上 (稀疏事件, 本轮未捕获直接反例, 按同因同治处理)
--   · equity_change      零星漏 (hk:00175 漏 07-15) —— 日频但偶发 T+1 披露
-- 三道既有防线全部漏判: alertIfDegraded 只看 failed / FreshnessSlaCheck 量 run 年龄且这些维度
-- sla_hours 全 NULL / rowsFetched 只有 connect_holding 一处埋点。
--
-- 定值规则 = **N ≥ 披露滞后 + 两次 tick 的实际间隔**:
--   · 日频 7  —— 覆盖 T+1 + 周末夹缝
--   · 周更 10 —— 实测 tick 间隔可达 8 天 (07-20 → 07-28: cron 写周一 22:00, claim 漂到近午夜,
--                asOf 随之漂) → 7 只剩 1 天余量, 取 10 留 3 天
-- NULL = 精确当日 (from=to=asOf), 即本 migration 前的全仓行为 ⇒ 未列出的维度**逐行零变化**。
--
-- 幂等: 各维度 delta 一律 createMany(skipDuplicates), 重叠日零翻倍
-- (connect_holding N=3 已在 prod 跑通一个月+, 本次随规则统一提到 7)。
-- migration_refs: docs/plans/2026-07/07-30-sellput-viz-p3b-data-architecture.md
--   (§9-F7/F8 观测缺口 / §10 Phase 3 既有问题清理)。

-- AlterTable: delta 回看窗 (可空 = 精确当日)
ALTER TABLE "marketdata"."sync_dimension"
  ADD COLUMN "delta_lookback_days" INTEGER;

-- Seed 回填 (幂等 —— 重跑同值覆盖零变更)。
-- 日频披露型 7: 覆盖 T+1 披露与周末夹缝。
UPDATE "marketdata"."sync_dimension" SET "delta_lookback_days" = 7
 WHERE "dimension_key" IN ('announcement', 'buyback', 'equity_change', 'connect_holding');

-- 周更事件型 10: cron 为 `* * 1`, 精确当日窗结构性只覆盖 1/7 的日子。
UPDATE "marketdata"."sync_dimension" SET "delta_lookback_days" = 10
 WHERE "dimension_key" IN ('shareholder_change', 'allotment');

-- 蓄意留 NULL (= 精确当日, 行为不变), 逐类理由:
--   · eod_bar / us_equity_bar / short_selling / volatility / fundamental —— 2026-08-01 实测数据
--     年龄均为 1 天 (上个交易日), 单日窗在这些端点上验证正常; 且是全仓最大的几张表, 无证据的
--     加宽只换来每晚成倍的重复行去重开销;
--   · fund_holding / fund_company_holding / revenue_segment / shareholder_snapshot / employee ——
--     报告期语义, delta 本就是**设计性空转** (公告日滞后季末 ~2 个月), 新鲜度靠周期 re-backfill,
--     加回看窗不解决问题 (前两者 0 行的真因是 re-backfill 从未被安排, 属 ops 缺口另行处置);
--   · universe / profile / index_membership / industry_classification —— 覆盖式 upsert, 无区间语义;
--   · corporate_action / financial / hot_snapshot —— 非 [asOf−N, asOf] 区间形态。
