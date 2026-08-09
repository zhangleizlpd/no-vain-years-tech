-- 042 港股报告期 3 张 market-agnostic 事实表 (营收构成/最新股东/员工)
-- + 3 sync_dimension seed 行 (marketScope={hk}, cron 统一季频) + 3 universe→dim soft 依赖边。
-- NK (probe verified 2026-07-15 prod 77 真 vendor): 营收 (instrument_id,date,parent_item_name,item_name)
--   22 期 0 碰撞; 员工 (instrument_id,date,parent_item_name,item_name,display_type) — 同名 number+percentage
--   两行经 display_type 全期 0 碰撞; 最新股东 (instrument_id,date,shareholder_name,content_hash) 复用 041
--   ShareholderChange 范式 (Data Vault hashdiff, 应对同股东同日多笔)。
-- expand-only: 仅 CREATE TABLE + unique index + FK + idempotent seed, 非破坏性 → 单 PR 合规
-- (ADR-0035 + migration-rules.md §2)。datasource schemas 已含 marketdata (015 立), 无需 CREATE SCHEMA。
-- DDL 段由 `prisma migrate diff --from-config-datasource --to-schema` 从 schema.prisma 生成 (零 drift),
-- 剔除 diff 误报的 `DROP INDEX ix_instrument_pinyin_abbr_trgm` (pg_trgm GIN 索引 schema.prisma 无法建模,
-- 属既有 committed 索引 20260602_1430, 本 migration 不触)。
-- migration_refs: specs/042-hk-marketdata-reporting-period (US1 营收构成回填 / US2 最新股东嵌套 L/S/P /
--   US3 员工 displayType 进 NK / FR-007 market-agnostic 表 / FR-011 cron 季频 / FR-001 marketScope 驱动工作集)。

-- CreateTable
CREATE TABLE "marketdata"."revenue_segment" (
    "id" BIGSERIAL NOT NULL,
    "instrument_id" BIGINT NOT NULL,
    "date" DATE NOT NULL,
    "declaration_date" DATE,
    "currency" VARCHAR,
    "parent_item_name" VARCHAR NOT NULL,
    "item_name" VARCHAR NOT NULL,
    "revenue" DECIMAL(24,2),
    "costs" DECIMAL(24,2),
    "gross_profit_margin" DECIMAL(10,6),

    CONSTRAINT "revenue_segment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketdata"."shareholder_snapshot" (
    "id" BIGSERIAL NOT NULL,
    "instrument_id" BIGINT NOT NULL,
    "date" DATE NOT NULL,
    "shareholder_name" VARCHAR NOT NULL,
    "content_hash" VARCHAR NOT NULL,
    "payload" JSONB NOT NULL,

    CONSTRAINT "shareholder_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketdata"."employee_snapshot" (
    "id" BIGSERIAL NOT NULL,
    "instrument_id" BIGINT NOT NULL,
    "date" DATE NOT NULL,
    "declaration_date" DATE,
    "parent_item_name" VARCHAR NOT NULL,
    "item_name" VARCHAR NOT NULL,
    "display_type" VARCHAR NOT NULL,
    "value" DECIMAL(20,4),

    CONSTRAINT "employee_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- 营收 NK 4 列 (probe verified 22 期 0 碰撞, 含 "其他" 跨两组不撞); 顶层无 parent 行 parent_item_name 落 sentinel ''。
CREATE UNIQUE INDEX "uk_revenue_segment_instrument_date_parent_item" ON "marketdata"."revenue_segment"("instrument_id", "date", "parent_item_name", "item_name");

-- CreateIndex
-- 自然键含 content_hash (复用 041 ShareholderChange, Data Vault hashdiff 应对同股东同日多笔)。
CREATE UNIQUE INDEX "uk_shareholder_snapshot_instrument_date_name_hash" ON "marketdata"."shareholder_snapshot"("instrument_id", "date", "shareholder_name", "content_hash");

-- CreateIndex
-- 自然键含 display_type (probe 实证同名 number+percentage 两行 (parent,item) 碰撞 → 加 display_type 全期 0 碰撞)。
CREATE UNIQUE INDEX "uk_employee_snapshot_instrument_date_parent_item_type" ON "marketdata"."employee_snapshot"("instrument_id", "date", "parent_item_name", "item_name", "display_type");

-- AddForeignKey
ALTER TABLE "marketdata"."revenue_segment" ADD CONSTRAINT "revenue_segment_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "marketdata"."instrument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketdata"."shareholder_snapshot" ADD CONSTRAINT "shareholder_snapshot_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "marketdata"."instrument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketdata"."employee_snapshot" ADD CONSTRAINT "employee_snapshot_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "marketdata"."instrument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed 3 报告期维度默认行 (idempotent ON CONFLICT DO NOTHING, 016 D3 先例)。
-- marketScope={hk} (新增维度仅港股, FR-001); vendor 全 lixinger; adjust_types={none} (报告期无复权口径);
--   batch_size=1 (per-stock 单请求); history_depth=3650 (3 维均可回填近 10 年报告期历史, 回测样本长度)。
-- cron 统一季频 '0 0 22 1 */3 *' (FR-011, plan Decision 5): 每季度首月 1 日 22:00 上海时区, 贴 HK 半年报/
--   年报 ~2x/年披露 — 纯 seed 表达 cadence, 零 schema 变更; 回填仍为一次性区间任务, 正交常态增量。
-- priority 4/3/2 (US1>US2>US3, 均低于 p1 核心 6 维 5-10 → 核心先吃共享令牌桶; 与 039/040/041 同 tier 值碰撞
--   无碍 — sync-flow-assembler tie-break = priority desc 再 key 字典序, 派生序确定性不依赖 priority 唯一)。
-- freshness_profile: 3 维均 slow-drift (低频报告期披露, 不做 continuous-daily 新鲜度门, 同 041 shareholder/allotment)。
-- sla_hours 留 NULL (报告期低频, 不做新鲜度 gating; 列省略 → 默认 NULL)。
INSERT INTO "marketdata"."sync_dimension"
  ("dimension_key", "enabled", "cron_expr", "vendor", "market_scope", "adjust_types", "batch_size", "history_depth", "priority", "freshness_profile")
VALUES
  ('revenue_segment',       true, '0 0 22 1 */3 *', 'lixinger', '{hk}'::text[], '{none}'::text[], 1, 3650, 4, 'slow-drift'),
  ('shareholder_snapshot',  true, '0 0 22 1 */3 *', 'lixinger', '{hk}'::text[], '{none}'::text[], 1, 3650, 3, 'slow-drift'),
  ('employee',              true, '0 0 22 1 */3 *', 'lixinger', '{hk}'::text[], '{none}'::text[], 1, 3650, 2, 'slow-drift')
ON CONFLICT ("dimension_key") DO NOTHING;

-- Seed 3 universe→dim soft 边 (idempotent, 017 先例)。universe→* 全 soft: universe 缺席/失败不拖垮
-- 这 3 维度日常同步 (标的须先注册, plan §Decisions 7 只挂 soft 避 assertEdgesExpressible 拓扑硬校验)。
INSERT INTO "marketdata"."sync_dependency" ("upstream", "downstream", "mode")
VALUES
  ('universe', 'revenue_segment',      'soft'),
  ('universe', 'shareholder_snapshot', 'soft'),
  ('universe', 'employee',             'soft')
ON CONFLICT ("upstream", "downstream") DO NOTHING;
