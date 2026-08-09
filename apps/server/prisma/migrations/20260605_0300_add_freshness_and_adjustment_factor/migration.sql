-- 019 schema expand (PR-1, 无行为变化 — 新列零消费者, 不加依赖边 D8 / 不改 cron):
-- ① sync_dimension 加声明式新鲜度三列 (freshness_profile / sla_hours / calendar_source);
-- ② 新表 adjustment_factor (复权因子版本, 标的 × 除权日, plan D1 价格比值锚定);
-- ③ seed UPDATE 画像回填 (幂等, 按 T001 探测结论: financial 无披露日历端点 → slow-drift)。
-- expand-only: 仅 ADD COLUMN (带 default/nullable) + CREATE TABLE + seed UPDATE → 单 PR
-- 合规 (ADR-0035 + migration-rules.md §2)。
-- migration_refs: specs/019-marketdata-sync-strategy (US1 因子表 / US2 画像列; FR-S01/S04/S09)。

-- AlterTable: sync_dimension 声明式新鲜度三列
ALTER TABLE "marketdata"."sync_dimension"
  ADD COLUMN "freshness_profile" VARCHAR(24) NOT NULL DEFAULT 'continuous-daily',
  ADD COLUMN "sla_hours" INTEGER,
  ADD COLUMN "calendar_source" VARCHAR(32);

-- CreateTable: 复权因子版本 (uk = instrument × ex_date; 同日多事件合并单版本)
CREATE TABLE "marketdata"."adjustment_factor" (
    "id" BIGSERIAL NOT NULL,
    "instrument_id" BIGINT NOT NULL,
    "ex_date" DATE NOT NULL,
    "factor_forward" DECIMAL(18,8) NOT NULL,
    "factor_backward" DECIMAL(18,8) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "adjustment_factor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uk_adjustment_factor_instrument_exdate" ON "marketdata"."adjustment_factor"("instrument_id", "ex_date");

-- AddForeignKey (同 schema intra FK, 与其他 marketdata 事实表同范式)
ALTER TABLE "marketdata"."adjustment_factor"
  ADD CONSTRAINT "adjustment_factor_instrument_id_fkey" FOREIGN KEY ("instrument_id")
  REFERENCES "marketdata"."instrument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed 画像回填 (幂等 UPDATE — default 已是 continuous-daily, 只改 slow-drift 三行 +
-- financial per T001 探测 fallback; sla_hours 全维度按 plan 初值; profile 不检查留 NULL):
--   universe/profile/corporate_action → slow-drift (corp 周扫即同步不自我 gate, analyze C1)
--   financial → slow-drift (T001 2026-06-05 实测: 无市场级披露日历端点, calendar_source 留 NULL)
--   eod_bar/fundamental → continuous-daily (default 已覆盖, 仅补 sla_hours)
UPDATE "marketdata"."sync_dimension" SET "freshness_profile" = 'slow-drift', "sla_hours" = 192
  WHERE "dimension_key" IN ('universe', 'corporate_action', 'financial');
UPDATE "marketdata"."sync_dimension" SET "freshness_profile" = 'slow-drift'
  WHERE "dimension_key" = 'profile';
UPDATE "marketdata"."sync_dimension" SET "sla_hours" = 30
  WHERE "dimension_key" IN ('eod_bar', 'fundamental');
