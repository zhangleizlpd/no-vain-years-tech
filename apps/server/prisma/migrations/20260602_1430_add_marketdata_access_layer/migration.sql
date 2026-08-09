-- 015 marketdata 可插拔数据访问层 (第 5 bounded context; ADR-0032 Q4 + ADR-0047)。
-- expand-only: 新建 schema + 6 张事实/注册表 + 索引 + pg_trgm extension + GIN trgm
-- index, 全为加结构、零破坏 → 单 PR 合规 (ADR-0035 + migration-rules.md §2)。
-- clarify 2026-06-02: 仅 6 张事实/注册表入 015; 同步配置/审计 3 表
-- (SyncDimension/SyncBlacklist/SyncRun) DDL 推迟 016。
-- 数据由 016 同步管线生产灌库; 本 feature 仅落 schema + 读路径, IT 用 seed fixtures。

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "marketdata";

-- pg_trgm: LocalInstrumentSearchAdapter 的本地模糊搜索备援 (名/拼音 similarity, FR-S04)。
-- raw SQL — Prisma schema 无法表达 extension + gin_trgm_ops index。
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateTable
CREATE TABLE "marketdata"."instrument" (
    "id" BIGSERIAL NOT NULL,
    "market" VARCHAR(8) NOT NULL,
    "code" VARCHAR(16) NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "type" VARCHAR(16) NOT NULL,
    "currency" VARCHAR(8) NOT NULL,
    "pinyin_abbr" VARCHAR(128),
    "pinyin_full" VARCHAR(256),
    "lixinger_company_type" VARCHAR(32),
    "sync_tier" INTEGER NOT NULL DEFAULT 2,
    "status" VARCHAR(16) NOT NULL,
    "list_date" DATE,
    "delist_date" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "instrument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketdata"."daily_bar" (
    "id" BIGSERIAL NOT NULL,
    "instrument_id" BIGINT NOT NULL,
    "trade_date" DATE NOT NULL,
    "adjust" VARCHAR(16) NOT NULL,
    "open" DECIMAL(18,4) NOT NULL,
    "high" DECIMAL(18,4) NOT NULL,
    "low" DECIMAL(18,4) NOT NULL,
    "close" DECIMAL(18,4) NOT NULL,
    "prev_close" DECIMAL(18,4),
    "volume" DECIMAL(20,0),
    "amount" DECIMAL(20,2),
    "turnover_rate" DECIMAL(10,4),

    CONSTRAINT "daily_bar_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketdata"."fundamental_snapshot" (
    "id" BIGSERIAL NOT NULL,
    "instrument_id" BIGINT NOT NULL,
    "date" DATE NOT NULL,
    "pe_ttm" DECIMAL(18,4),
    "pe_static" DECIMAL(18,4),
    "pe_dynamic" DECIMAL(18,4),
    "pb" DECIMAL(18,4),
    "ps" DECIMAL(18,4),
    "dividend_yield" DECIMAL(10,4),
    "market_cap" DECIMAL(24,2),
    "circ_market_cap" DECIMAL(24,2),
    "pe_pctl_y3" DECIMAL(8,4),
    "pe_pctl_y5" DECIMAL(8,4),
    "pb_pctl_y3" DECIMAL(8,4),
    "pb_pctl_y5" DECIMAL(8,4),

    CONSTRAINT "fundamental_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketdata"."financial_metric" (
    "id" BIGSERIAL NOT NULL,
    "instrument_id" BIGINT NOT NULL,
    "report_period" VARCHAR(8) NOT NULL,
    "roe" DECIMAL(10,4),
    "gross_margin" DECIMAL(10,4),
    "eps" DECIMAL(18,4),
    "bps" DECIMAL(18,4),

    CONSTRAINT "financial_metric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketdata"."corporate_action" (
    "id" BIGSERIAL NOT NULL,
    "instrument_id" BIGINT NOT NULL,
    "ex_date" DATE NOT NULL,
    "type" VARCHAR(16) NOT NULL,
    "payload" JSONB NOT NULL,

    CONSTRAINT "corporate_action_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketdata"."trading_day" (
    "market" VARCHAR(8) NOT NULL,
    "date" DATE NOT NULL,

    CONSTRAINT "trading_day_pkey" PRIMARY KEY ("market","date")
);

-- CreateIndex
CREATE UNIQUE INDEX "uk_instrument_market_code" ON "marketdata"."instrument"("market", "code");

-- CreateIndex: GIN trigram on pinyin_abbr — 本地模糊搜索备援 (pg_trgm similarity)。
-- Prisma schema 无法表达 gin_trgm_ops, 故 raw SQL。
CREATE INDEX "ix_instrument_pinyin_abbr_trgm" ON "marketdata"."instrument" USING GIN ("pinyin_abbr" gin_trgm_ops);

-- CreateIndex
CREATE UNIQUE INDEX "uk_daily_bar_instrument_date_adjust" ON "marketdata"."daily_bar"("instrument_id", "trade_date", "adjust");

-- CreateIndex
CREATE INDEX "ix_daily_bar_instrument_date" ON "marketdata"."daily_bar"("instrument_id", "trade_date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "uk_fundamental_snapshot_instrument_date" ON "marketdata"."fundamental_snapshot"("instrument_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "uk_financial_metric_instrument_period" ON "marketdata"."financial_metric"("instrument_id", "report_period");

-- CreateIndex
CREATE UNIQUE INDEX "uk_corporate_action_instrument_exdate_type" ON "marketdata"."corporate_action"("instrument_id", "ex_date", "type");

-- AddForeignKey (同 schema intra FK — referential integrity; 跨 ctx 引用才禁 FK)
ALTER TABLE "marketdata"."daily_bar" ADD CONSTRAINT "daily_bar_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "marketdata"."instrument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketdata"."fundamental_snapshot" ADD CONSTRAINT "fundamental_snapshot_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "marketdata"."instrument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketdata"."financial_metric" ADD CONSTRAINT "financial_metric_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "marketdata"."instrument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketdata"."corporate_action" ADD CONSTRAINT "corporate_action_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "marketdata"."instrument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
