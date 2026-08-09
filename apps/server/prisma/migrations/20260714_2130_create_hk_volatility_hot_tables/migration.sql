-- 040 港股波动率 + 热度精选 2 张 market-agnostic 事实表 (日频历史波动率 / 热度精选快照)
-- + 2 sync_dimension seed 行 (marketScope={hk}) + 2 universe→dim soft 依赖边。
-- expand-only: 仅 CREATE TABLE + unique index + FK + idempotent seed, 非破坏性 → 单 PR 合规
-- (ADR-0035 + migration-rules.md §2)。datasource schemas 已含 marketdata (015 立), 无需 CREATE SCHEMA。
-- DDL 段由 `prisma migrate diff --from-config-datasource --to-schema` 从 schema.prisma 生成 (零 drift),
-- 剔除 diff 误报的 `DROP INDEX ix_instrument_pinyin_abbr_trgm` (pg_trgm GIN 索引 schema.prisma 无法建模,
-- 属既有 committed 索引 20260602_1430, 本 migration 不触)。
-- migration_refs: specs/040-hk-marketdata-volatility-hot (US1 波动率日频回填 × 多窗口 /
--   US2 热度精选快照按数据日期累积 / FR-008 market-agnostic 表 / FR-001 marketScope 驱动工作集)。

-- CreateTable
CREATE TABLE "marketdata"."volatility_daily" (
    "id" BIGSERIAL NOT NULL,
    "instrument_id" BIGINT NOT NULL,
    "date" DATE NOT NULL,
    "volatility_days" INTEGER NOT NULL,
    "value" DECIMAL(12,8),

    CONSTRAINT "volatility_daily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketdata"."hot_snapshot" (
    "id" BIGSERIAL NOT NULL,
    "instrument_id" BIGINT NOT NULL,
    "hot_type" VARCHAR(16) NOT NULL,
    "data_date" DATE NOT NULL,
    "payload" JSONB NOT NULL,

    CONSTRAINT "hot_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uk_volatility_daily_instrument_date_days" ON "marketdata"."volatility_daily"("instrument_id", "date", "volatility_days");

-- CreateIndex
CREATE UNIQUE INDEX "uk_hot_snapshot_instrument_type_date" ON "marketdata"."hot_snapshot"("instrument_id", "hot_type", "data_date");

-- AddForeignKey
ALTER TABLE "marketdata"."volatility_daily" ADD CONSTRAINT "volatility_daily_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "marketdata"."instrument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketdata"."hot_snapshot" ADD CONSTRAINT "hot_snapshot_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "marketdata"."instrument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed 2 维度默认行 (idempotent ON CONFLICT DO NOTHING, 016 D3 先例)。
-- marketScope={hk} (新增维度仅港股, FR-001); vendor 全 lixinger; cron 默认 22:00 (配置驱动, 016 F7:
--   cadence 经验测后改 sync_dimension 不改代码); adjust_types={} (无复权口径); batch_size=1 (per-stock 单请求)。
-- 窗口/type 子集 (volatilityDays 30/60/250, hot ss/tr/capita/rep) = adapter 常量 (非 DB 配置, plan
--   Decision 5) → sync_dimension 只存 marketScope/history_depth/freshness, 不存窗口/type 配置字段。
-- history_depth: 波动率日频近 10 年 (3650, 回测样本长度); 热度快照无历史深度概念 (NULL, vendor 只返当前快照)。
-- priority 4/3 (均低于 p1 核心 6 维 5-10 → 核心先吃共享令牌桶; 与 039 同 tier 值碰撞无碍 —
--   sync-flow-assembler tie-break = priority desc 再 key 字典序, 派生序确定性不依赖 priority 唯一)。
-- freshness_profile: 波动率 continuous-daily (日频序列); 热度 slow-drift (快照累积, 近 index_membership)。
-- sla_hours 留 NULL (新维度 cadence 待 ops 验证后再设, 先不做新鲜度 gating — 避供给未稳时误报 stale, INV-3 supervised)。
INSERT INTO "marketdata"."sync_dimension"
  ("dimension_key", "enabled", "cron_expr", "vendor", "market_scope", "adjust_types", "batch_size", "history_depth", "priority", "freshness_profile")
VALUES
  ('volatility',   true, '0 0 22 * * *', 'lixinger', '{hk}'::text[], '{}'::text[], 1, 3650, 4, 'continuous-daily'),
  ('hot_snapshot', true, '0 0 22 * * *', 'lixinger', '{hk}'::text[], '{}'::text[], 1, NULL, 3, 'slow-drift')
ON CONFLICT ("dimension_key") DO NOTHING;

-- Seed 2 universe→dim soft 边 (idempotent, 017 先例)。universe→* 全 soft: universe 缺席/失败不拖垮
-- 这 2 维度日常同步 (标的须先注册, plan §Decisions 只挂 soft 避 assertEdgesExpressible 拓扑硬校验)。
INSERT INTO "marketdata"."sync_dependency" ("upstream", "downstream", "mode")
VALUES
  ('universe', 'volatility',   'soft'),
  ('universe', 'hot_snapshot', 'soft')
ON CONFLICT ("upstream", "downstream") DO NOTHING;
