-- 采集闸 need_sync (expand-only —— 仅 ADD COLUMN 带 default + seed UPDATE, 无破坏性变更,
-- 单 PR 合规 per .claude/rules/migration-rules.md §2):
--   ① instrument 加 need_sync BOOLEAN NOT NULL DEFAULT true —— 既有全表落 true;
--   ② us 存量刷 false —— 「无锚不采」。us 标的**仍全量在库**供搜索 / 发现候选, 只是不进任何
--      同步维度的工作集 (「全量入库」与「要不要采」彻底分开)。
-- 零回归论证: 既有 22 个维度的 market_scope 均为 {cn,hk} (仅 universe 含 us, 而 universe 是
-- 枚举入库、不经工作集), 且 cn/hk 全部落 true → 各维度工作集逐行不变。
-- 新增标的的默认值由**单一写入点** SyncUniverseUseCase.upsert 的 create 分支按市场决定
-- (us → false / 其余 → true); update 分支不写本列 (与 sync_tier / lixinger_company_type 同属
-- 受保护列), 否则每轮 universe 同步会重置人工配置。
-- migration_refs: docs/plans/2026-07/07-30-sellput-viz-p3b-data-architecture.md
--   (§4.4 us 采集工作集判据 = 成员制 / §10 Phase 2 前期准备)。

-- AlterTable: instrument 采集闸
ALTER TABLE "marketdata"."instrument"
  ADD COLUMN "need_sync" BOOLEAN NOT NULL DEFAULT true;

-- Seed 回填 (幂等 —— 重跑同值覆盖零变更): us 存量转「不采」, 后续逐只开启 (过渡期人工 SQL;
-- p4 落 P6 锚管理后由「有无锚」驱动, 沿用 sync-tier-recalc 的 CROSS-CONTEXT-READ 范式)。
UPDATE "marketdata"."instrument" SET "need_sync" = false WHERE "market" = 'us';
