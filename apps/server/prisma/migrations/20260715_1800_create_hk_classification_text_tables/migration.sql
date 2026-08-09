-- 043 港股分类文本 2 张 market-agnostic 事实表 (所属行业/公告)
-- + 2 sync_dimension seed 行 (marketScope={hk}, cron 统一夜频) + 2 universe→dim soft 依赖边。
-- NK (probe verified 2026-07-15 prod 77 真 vendor):
--   所属行业 (instrument_id,source,industry_code) — 覆盖式快照无 date, 3 级层级 3 行/股各异不撞;
--     source 纳 NK (行业天然多分类体系 GICS/申万/hsi, 今 probe 全 hsi), industry_code = vendor 行 stockCode
--     字段 (H70 恒生行业节点, 消歧落此列)。
--   公告 (instrument_id,date,link_url) — link_url 是 HKEX 文档全局唯一 URL (00700 2 年 433/433 unique,
--     (date,link_url) 433/433 无碰撞), 无需 vendor_event_id/content_hash。
-- expand-only: 仅 CREATE TABLE + unique/时序 index + FK + idempotent seed, 非破坏性 → 单 PR 合规
-- (ADR-0035 + migration-rules.md §2)。datasource schemas 已含 marketdata (015 立), 无需 CREATE SCHEMA。
-- DDL 段由 `prisma migrate diff --from-config-datasource --to-schema` 从 schema.prisma 生成 (零 drift),
-- 剔除 diff 误报的 `DROP INDEX ix_instrument_pinyin_abbr_trgm` (pg_trgm GIN 索引 schema.prisma 无法建模,
-- 属既有 committed 索引 20260602_1430, 本 migration 不触)。
-- migration_refs: specs/043-hk-marketdata-classification-text (US1 所属行业覆盖式快照 3 级层级 / US2 公告
--   range 文本流只存元数据 / FR-007 market-agnostic 表 / FR-011 cron 统一夜频二档 / FR-001 marketScope 驱动工作集)。

-- CreateTable
CREATE TABLE "marketdata"."industry_classification" (
    "id" BIGSERIAL NOT NULL,
    "instrument_id" BIGINT NOT NULL,
    "source" VARCHAR(32) NOT NULL,
    "industry_code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(128),
    "area_code" VARCHAR(8),

    CONSTRAINT "industry_classification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketdata"."announcement" (
    "id" BIGSERIAL NOT NULL,
    "instrument_id" BIGINT NOT NULL,
    "date" DATE NOT NULL,
    "link_url" VARCHAR(512) NOT NULL,
    "link_text" VARCHAR(512),
    "link_type" VARCHAR(16),
    "types" TEXT[],

    CONSTRAINT "announcement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- 所属行业 NK 3 列 (probe verified 3 级层级 3 行/股各异不撞, source 纳 NK 未来多分类体系无缝)。
CREATE UNIQUE INDEX "uk_industry_classification_instrument_source_code" ON "marketdata"."industry_classification"("instrument_id", "source", "industry_code");

-- CreateIndex
-- 公告 (instrument_id, date desc) 时序索引护超大表 (~3M 行/10yr) 最近 N 日扫描 (同 daily_bar, plan Decision 7)。
CREATE INDEX "ix_announcement_instrument_date" ON "marketdata"."announcement"("instrument_id", "date" DESC);

-- CreateIndex
-- 公告 NK 3 列 (link_url 天然唯一, 同 URL 折叠/不同 URL 保留)。
CREATE UNIQUE INDEX "uk_announcement_instrument_date_link" ON "marketdata"."announcement"("instrument_id", "date", "link_url");

-- AddForeignKey
ALTER TABLE "marketdata"."industry_classification" ADD CONSTRAINT "industry_classification_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "marketdata"."instrument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketdata"."announcement" ADD CONSTRAINT "announcement_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "marketdata"."instrument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed 2 分类文本维度默认行 (idempotent ON CONFLICT DO NOTHING, 016 D3 先例)。
-- marketScope={hk} (新增维度仅港股, FR-001); vendor 全 lixinger; adjust_types={none} (分类/文本无复权);
--   batch_size=1 (per-stock 单请求)。cron 统一夜频 '0 0 22 * * *' (FR-011, plan Decision 5): 共用
--   master INV-3 错峰夜窗 (同 index_membership/short_selling, 异于 042 报告期季频) — 纯 seed 表达 cadence,
--   零 schema 变更。freshness 二档: industry_classification=slow-drift (分类罕变, 恒覆盖式确认, 照
--   index_membership 夜频); announcement=continuous-daily (文本流每日新披露)。history_depth 二档:
--   industry_classification=NULL (覆盖式无历史, 不纳回填估算, 同 index_membership); announcement=3650
--   (10yr, ≤10yr 硬上限内, 回测事件研究窗口最全, user 2026-07-15 拍板)。priority 2/1 (US1>US2, 均低于
--   p1 核心 6 维 5-10 → 核心先吃共享令牌桶; 与 039-042 同 tier 值碰撞无碍 — tie-break = priority desc
--   再 key 字典序, 派生序确定性不依赖 priority 唯一)。sla_hours 留 NULL (不做新鲜度 gating, 列省略默认 NULL)。
INSERT INTO "marketdata"."sync_dimension"
  ("dimension_key", "enabled", "cron_expr", "vendor", "market_scope", "adjust_types", "batch_size", "history_depth", "priority", "freshness_profile")
VALUES
  ('industry_classification', true, '0 0 22 * * *', 'lixinger', '{hk}'::text[], '{none}'::text[], 1, NULL, 2, 'slow-drift'),
  ('announcement',            true, '0 0 22 * * *', 'lixinger', '{hk}'::text[], '{none}'::text[], 1, 3650, 1, 'continuous-daily')
ON CONFLICT ("dimension_key") DO NOTHING;

-- Seed 2 universe→dim soft 边 (idempotent, 017 先例)。universe→* 全 soft: universe 缺席/失败不拖垮
-- 这 2 维度日常同步 (标的须先注册, plan §Decisions 6 只挂 soft 避 assertEdgesExpressible 拓扑硬校验)。
INSERT INTO "marketdata"."sync_dependency" ("upstream", "downstream", "mode")
VALUES
  ('universe', 'industry_classification', 'soft'),
  ('universe', 'announcement',            'soft')
ON CONFLICT ("upstream", "downstream") DO NOTHING;
