-- 041 港股事件流 4 张 market-agnostic 事实表 (回购/股本变动/股东权益变动/配股)
-- + 4 sync_dimension seed 行 (marketScope={hk}) + 4 universe→dim soft 依赖边。
-- C1 扩键 (T018 真 vendor read-only 探针实证同日多事件): buyback NK 加 vendor_event_id (vendor `_id`),
--   shareholder NK 加 content_hash (vendor 原始行 sha256 hashdiff) — 防 (instrument_id,date[,name]) 单键
--   skipDuplicates 丢真行。equity_change/allotment NK 不动 (探针证 equity 1/日安全 / allotment 零样本)。
-- expand-only: 仅 CREATE TABLE + unique index + FK + idempotent seed, 非破坏性 → 单 PR 合规
-- (ADR-0035 + migration-rules.md §2)。datasource schemas 已含 marketdata (015 立), 无需 CREATE SCHEMA。
-- DDL 段由 `prisma migrate diff --from-config-datasource --to-schema` 从 schema.prisma 生成 (零 drift),
-- 剔除 diff 误报的 `DROP INDEX ix_instrument_pinyin_abbr_trgm` (pg_trgm GIN 索引 schema.prisma 无法建模,
-- 属既有 committed 索引 20260602_1430, 本 migration 不触)。
-- migration_refs: specs/041-hk-marketdata-corporate-events (US1 回购事件回填 / US2 股本变动 /
--   US3 股东权益变动嵌套 L/S / US4 配股罕见零样本 / FR-008 market-agnostic 表 / FR-012 cron 分档 /
--   FR-001 marketScope 驱动工作集)。

-- CreateTable
CREATE TABLE "marketdata"."buyback_event" (
    "id" BIGSERIAL NOT NULL,
    "instrument_id" BIGINT NOT NULL,
    "date" DATE NOT NULL,
    "vendor_event_id" VARCHAR NOT NULL,
    "num" BIGINT,
    "highest_price" DECIMAL(18,4),
    "lowest_price" DECIMAL(18,4),
    "avg_price" DECIMAL(18,4),
    "total_paid" DECIMAL(24,2),
    "total_shares_for_cancellation" BIGINT,
    "total_shares_for_treasury" BIGINT,
    "ratio_purchased_since_resolution" DECIMAL(10,6),
    "method_of_purchase" VARCHAR,
    "currency" VARCHAR,
    "board_type" VARCHAR,

    CONSTRAINT "buyback_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketdata"."equity_change" (
    "id" BIGSERIAL NOT NULL,
    "instrument_id" BIGINT NOT NULL,
    "date" DATE NOT NULL,
    "capitalization" DECIMAL(24,0),
    "capitalization_h" DECIMAL(24,0),
    "change_reason" VARCHAR(64),
    "declaration_date" DATE,

    CONSTRAINT "equity_change_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketdata"."shareholder_change" (
    "id" BIGSERIAL NOT NULL,
    "instrument_id" BIGINT NOT NULL,
    "date" DATE NOT NULL,
    "shareholder_name" VARCHAR NOT NULL,
    "content_hash" VARCHAR NOT NULL,
    "payload" JSONB NOT NULL,

    CONSTRAINT "shareholder_change_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketdata"."allotment_event" (
    "id" BIGSERIAL NOT NULL,
    "instrument_id" BIGINT NOT NULL,
    "date" DATE NOT NULL,
    "payload" JSONB NOT NULL,

    CONSTRAINT "allotment_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- 自然键含 vendor_event_id (T018 真调实证同日多笔两市场回购真实存在 → 3 列 NK 防 skipDuplicates 丢真行)。
CREATE UNIQUE INDEX "uk_buyback_event_instrument_date_vendor" ON "marketdata"."buyback_event"("instrument_id", "date", "vendor_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "uk_equity_change_instrument_date" ON "marketdata"."equity_change"("instrument_id", "date");

-- CreateIndex
-- 自然键含 content_hash (T018 真调实证同股东同日多笔申报真实存在 → 4 列 NK, Data Vault hashdiff 防丢真行)。
CREATE UNIQUE INDEX "uk_shareholder_change_instrument_date_name_hash" ON "marketdata"."shareholder_change"("instrument_id", "date", "shareholder_name", "content_hash");

-- CreateIndex
CREATE UNIQUE INDEX "uk_allotment_event_instrument_date" ON "marketdata"."allotment_event"("instrument_id", "date");

-- AddForeignKey
ALTER TABLE "marketdata"."buyback_event" ADD CONSTRAINT "buyback_event_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "marketdata"."instrument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketdata"."equity_change" ADD CONSTRAINT "equity_change_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "marketdata"."instrument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketdata"."shareholder_change" ADD CONSTRAINT "shareholder_change_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "marketdata"."instrument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketdata"."allotment_event" ADD CONSTRAINT "allotment_event_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "marketdata"."instrument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed 4 事件流维度默认行 (idempotent ON CONFLICT DO NOTHING, 016 D3 先例)。
-- marketScope={hk} (新增维度仅港股, FR-001); vendor 全 lixinger; adjust_types={none} (事件流无复权口径);
--   batch_size=1 (per-stock 单请求); history_depth=3650 (4 维均可回填近 10 年事件历史, 回测样本长度)。
-- cron 分档 (FR-012, plan Decision 6): 回购/股本变动 = 日频 (高频事件及时入库); 股东权益变动/配股 =
--   周频 (Monday, 低频披露省调用) — 纯 seed 表达 cadence, 零 schema 变更; 回填仍为一次性区间任务, 正交常态增量。
-- priority 4/3/2/1 (均低于 p1 核心 6 维 5-10 → 核心先吃共享令牌桶; 与 039/040 同 tier 值碰撞无碍 —
--   sync-flow-assembler tie-break = priority desc 再 key 字典序, 派生序确定性不依赖 priority 唯一)。
-- freshness_profile: 4 事件流均 slow-drift (低频披露, 不做 continuous-daily 新鲜度门, 同 039 低频维度)。
-- sla_hours 留 NULL (新维度 cadence 待 ops 验证后再设, 先不做新鲜度 gating — 避供给未稳时误报 stale, INV-3 supervised)。
INSERT INTO "marketdata"."sync_dimension"
  ("dimension_key", "enabled", "cron_expr", "vendor", "market_scope", "adjust_types", "batch_size", "history_depth", "priority", "freshness_profile")
VALUES
  ('buyback',            true, '0 0 22 * * *', 'lixinger', '{hk}'::text[], '{none}'::text[], 1, 3650, 4, 'slow-drift'),
  ('equity_change',      true, '0 0 22 * * *', 'lixinger', '{hk}'::text[], '{none}'::text[], 1, 3650, 3, 'slow-drift'),
  ('shareholder_change', true, '0 0 22 * * 1', 'lixinger', '{hk}'::text[], '{none}'::text[], 1, 3650, 2, 'slow-drift'),
  ('allotment',          true, '0 0 22 * * 1', 'lixinger', '{hk}'::text[], '{none}'::text[], 1, 3650, 1, 'slow-drift')
ON CONFLICT ("dimension_key") DO NOTHING;

-- Seed 4 universe→dim soft 边 (idempotent, 017 先例)。universe→* 全 soft: universe 缺席/失败不拖垮
-- 这 4 维度日常同步 (标的须先注册, plan §Decisions 7 只挂 soft 避 assertEdgesExpressible 拓扑硬校验)。
INSERT INTO "marketdata"."sync_dependency" ("upstream", "downstream", "mode")
VALUES
  ('universe', 'buyback',            'soft'),
  ('universe', 'equity_change',      'soft'),
  ('universe', 'shareholder_change', 'soft'),
  ('universe', 'allotment',          'soft')
ON CONFLICT ("upstream", "downstream") DO NOTHING;
