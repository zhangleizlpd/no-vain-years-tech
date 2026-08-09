-- 039 港股量化高信号 5 张 market-agnostic 事实表 (做空/南向/所属指数/公募基金持股/基金公司持股)
-- + 5 sync_dimension seed 行 (marketScope={hk}) + 5 universe→dim soft 依赖边。
-- expand-only: 仅 CREATE TABLE + unique index + FK + idempotent seed, 非破坏性 → 单 PR 合规
-- (ADR-0035 + migration-rules.md §2)。datasource schemas 已含 marketdata (015 立), 无需 CREATE SCHEMA。
-- DDL 段由 `prisma migrate diff` 从 schema.prisma 生成 (零 drift), 剔除 diff 误报的
-- `DROP INDEX ix_instrument_pinyin_abbr_trgm` (pg_trgm GIN 索引 schema.prisma 无法建模, 属既有
-- committed 索引 20260602_1430, 本 migration 不触)。
-- migration_refs: specs/039-hk-marketdata-quant-signals (US1 做空/南向日频 / US2 基金持股报告期 /
--   US3 所属指数快照 / FR-006 market-agnostic 表 / FR-001 marketScope 驱动工作集)。

-- CreateTable
CREATE TABLE "marketdata"."short_selling_daily" (
    "id" BIGSERIAL NOT NULL,
    "instrument_id" BIGINT NOT NULL,
    "date" DATE NOT NULL,
    "shares" DECIMAL(20,0),
    "amount" DECIMAL(24,2),

    CONSTRAINT "short_selling_daily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketdata"."connect_holding_daily" (
    "id" BIGSERIAL NOT NULL,
    "instrument_id" BIGINT NOT NULL,
    "date" DATE NOT NULL,
    "shareholdings" DECIMAL(20,0),

    CONSTRAINT "connect_holding_daily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketdata"."index_membership" (
    "id" BIGSERIAL NOT NULL,
    "instrument_id" BIGINT NOT NULL,
    "index_code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(128),
    "source" VARCHAR(32),
    "area_code" VARCHAR(8),

    CONSTRAINT "index_membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketdata"."fund_holding" (
    "id" BIGSERIAL NOT NULL,
    "instrument_id" BIGINT NOT NULL,
    "report_date" DATE NOT NULL,
    "fund_code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(128),
    "holdings" DECIMAL(20,0),
    "market_cap" DECIMAL(24,2),
    "net_value_ratio" DECIMAL(10,4),
    "market_cap_rank" INTEGER,
    "proportion_outstanding_shares_a" DECIMAL(10,4),
    "declaration_date" DATE,

    CONSTRAINT "fund_holding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketdata"."fund_company_holding" (
    "id" BIGSERIAL NOT NULL,
    "instrument_id" BIGINT NOT NULL,
    "report_date" DATE NOT NULL,
    "fund_collection_code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(128),
    "holdings" DECIMAL(20,0),
    "market_cap" DECIMAL(24,2),

    CONSTRAINT "fund_company_holding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uk_short_selling_daily_instrument_date" ON "marketdata"."short_selling_daily"("instrument_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "uk_connect_holding_daily_instrument_date" ON "marketdata"."connect_holding_daily"("instrument_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "uk_index_membership_instrument_index" ON "marketdata"."index_membership"("instrument_id", "index_code");

-- CreateIndex
CREATE UNIQUE INDEX "uk_fund_holding_instrument_report_fund" ON "marketdata"."fund_holding"("instrument_id", "report_date", "fund_code");

-- CreateIndex
CREATE UNIQUE INDEX "uk_fund_company_holding_instrument_report_collection" ON "marketdata"."fund_company_holding"("instrument_id", "report_date", "fund_collection_code");

-- AddForeignKey
ALTER TABLE "marketdata"."short_selling_daily" ADD CONSTRAINT "short_selling_daily_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "marketdata"."instrument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketdata"."connect_holding_daily" ADD CONSTRAINT "connect_holding_daily_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "marketdata"."instrument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketdata"."index_membership" ADD CONSTRAINT "index_membership_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "marketdata"."instrument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketdata"."fund_holding" ADD CONSTRAINT "fund_holding_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "marketdata"."instrument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketdata"."fund_company_holding" ADD CONSTRAINT "fund_company_holding_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "marketdata"."instrument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed 5 维度默认行 (idempotent ON CONFLICT DO NOTHING, 016 D3 先例)。
-- marketScope={hk} (新增维度仅港股, FR-001); vendor 全 lixinger; cron 默认 22:00 (配置驱动, 016 F7:
--   cadence 经验测后改 sync_dimension 不改代码); adjust_types={} (无复权口径); batch_size=1 (per-stock 单请求)。
-- history_depth: 做空/南向日频近 10 年 (3650); 公募/基金公司持股受控近 5 年 (1825, FR-005); 所属指数无历史 (NULL)。
-- priority 4/3/2/1/0 (均低于 p1 核心 6 维 5-10 → 核心先吃共享令牌桶)。
-- freshness_profile: 做空/南向 continuous-daily; 基金持股(报告期)/所属指数(快照) slow-drift。
-- sla_hours 留 NULL (新维度 cadence 待 ops 验证后再设, 先不做新鲜度 gating — 避供给未稳时误报 stale, INV-3 supervised)。
INSERT INTO "marketdata"."sync_dimension"
  ("dimension_key", "enabled", "cron_expr", "vendor", "market_scope", "adjust_types", "batch_size", "history_depth", "priority", "freshness_profile")
VALUES
  ('short_selling',        true, '0 0 22 * * *', 'lixinger', '{hk}'::text[], '{}'::text[], 1, 3650, 4, 'continuous-daily'),
  ('connect_holding',      true, '0 0 22 * * *', 'lixinger', '{hk}'::text[], '{}'::text[], 1, 3650, 3, 'continuous-daily'),
  ('fund_holding',         true, '0 0 22 * * *', 'lixinger', '{hk}'::text[], '{}'::text[], 1, 1825, 2, 'slow-drift'),
  ('fund_company_holding', true, '0 0 22 * * *', 'lixinger', '{hk}'::text[], '{}'::text[], 1, 1825, 1, 'slow-drift'),
  ('index_membership',     true, '0 0 22 * * *', 'lixinger', '{hk}'::text[], '{}'::text[], 1, NULL, 0, 'slow-drift')
ON CONFLICT ("dimension_key") DO NOTHING;

-- Seed 5 universe→dim soft 边 (idempotent, 017 先例)。universe→* 全 soft: universe 缺席/失败不拖垮
-- 这 5 维度日常同步 (标的须先注册, plan §Decisions 3 只挂 soft 避 assertEdgesExpressible 拓扑硬校验)。
INSERT INTO "marketdata"."sync_dependency" ("upstream", "downstream", "mode")
VALUES
  ('universe', 'short_selling',        'soft'),
  ('universe', 'connect_holding',      'soft'),
  ('universe', 'fund_holding',         'soft'),
  ('universe', 'fund_company_holding', 'soft'),
  ('universe', 'index_membership',     'soft')
ON CONFLICT ("upstream", "downstream") DO NOTHING;
