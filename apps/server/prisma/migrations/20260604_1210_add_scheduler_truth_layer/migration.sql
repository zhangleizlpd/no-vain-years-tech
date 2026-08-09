-- 017 PG 调度真相层 expand (ADR-0049): SyncDimension + next_fire_at/misfire_policy、
-- SyncRun + bull_job_id、新表 sync_dependency + 唯一边键 + idempotent seed 6 边。
-- expand-only: 仅 ADD COLUMN (nullable/带 default) + CREATE TABLE + seed, 非破坏性 → 单 PR
-- 合规 (ADR-0035 + migration-rules.md §2)。next_fire_at 不回填 (clarify Q1: NULL = 未物化
-- 哨兵, tick 懒初始化不补跑)。
-- migration_refs: specs/017-marketdata-scheduler (US2 真相层 schema+种子边; FR-S01/S02)。

-- AlterTable: sync_dimension 调度真相列
ALTER TABLE "marketdata"."sync_dimension"
  ADD COLUMN "next_fire_at" TIMESTAMPTZ(6),
  ADD COLUMN "misfire_policy" VARCHAR(16) NOT NULL DEFAULT 'fire-now';

-- AlterTable: sync_run 回链 BullMQ job id (per-dim 路径写入; 旧聚合行 NULL)
ALTER TABLE "marketdata"."sync_run"
  ADD COLUMN "bull_job_id" VARCHAR(64);

-- CreateTable: 维度依赖边 (mode: 'hard' 断下游 / 'soft' 下游照跑)
CREATE TABLE "marketdata"."sync_dependency" (
    "id" BIGSERIAL NOT NULL,
    "upstream" VARCHAR(32) NOT NULL,
    "downstream" VARCHAR(32) NOT NULL,
    "mode" VARCHAR(8) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_dependency_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uk_sync_dependency_edge" ON "marketdata"."sync_dependency"("upstream", "downstream");

-- Seed 6 边 (idempotent ON CONFLICT DO NOTHING, 016 D3 先例)。
-- universe→* 全 soft (FR-S02 第一道拦截: universe 缺席/失败不拖垮全市场日常同步);
-- profile→fundamental hard (基本面快照依赖标的画像就绪, 016 D3 既有语义)。
INSERT INTO "marketdata"."sync_dependency" ("upstream", "downstream", "mode")
VALUES
  ('universe', 'profile',           'soft'),
  ('universe', 'eod_bar',           'soft'),
  ('universe', 'fundamental',       'soft'),
  ('universe', 'financial',         'soft'),
  ('universe', 'corporate_action',  'soft'),
  ('profile',  'fundamental',       'hard')
ON CONFLICT ("upstream", "downstream") DO NOTHING;
