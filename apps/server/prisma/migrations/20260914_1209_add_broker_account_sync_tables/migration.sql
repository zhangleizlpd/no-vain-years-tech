-- 注: prisma migrate dev 误生成的 `DROP INDEX ix_instrument_pinyin_abbr_trgm` 已剔除 —
-- 该 GIN 三元组拼音索引由 raw SQL migration 建 (20260602_1430, prisma schema 表达不了),
-- prisma 不认识非要删它 (本 wrapper scripts/prisma-migrate.ts 自动剔除)。

-- 082 券商账户拉取式同步底座 (T010; plan D7, D9): optionsdesk 新增六张 `broker_` 表。
-- **纯加法**: 只 CREATE TABLE / CREATE INDEX, 不触碰任何既有表 / 列 / 约束 ⇒ 非破坏性 expand,
-- 单 PR 合规 (ADR-0035 + migration-rules.md §2), image-only 回滚安全 (旧镜像不读这些表)。
--
-- 设计意图 SoT = schema.prisma「券商账户镜像」段头注释, 此处不镜像字段表。两条易误改的约束:
--   - `uk_broker_sync_run_reconcile_active` 是**部分**唯一索引 = 对账防重入第二层 (D9):
--     同连接同市场同交易日至多一条 running|succeeded 的对账。🚫 改成全表唯一 —— 会让失败后
--     的重试 (同交易日第二条记录) 永远插不进去。
--   - `uk_broker_sync_run_connection_source_event` 必须带 connection_id (D10 订阅方幂等键);
--     source_event_id 可空, PG 唯一索引对 NULL 互不冲突, 对账记录 (无事件 ID) 不受限。

-- CreateTable
CREATE TABLE "optionsdesk"."broker_connection" (
    "id" BIGSERIAL NOT NULL,
    "account_id" BIGINT NOT NULL,
    "broker_code" VARCHAR(16) NOT NULL,
    "label" VARCHAR(64) NOT NULL,
    "phone_last4" VARCHAR(4) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "broker_connection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "optionsdesk"."broker_position" (
    "id" BIGSERIAL NOT NULL,
    "account_id" BIGINT NOT NULL,
    "connection_id" BIGINT NOT NULL,
    "market" VARCHAR(4) NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "underlying_ticker" VARCHAR(32),
    "qty" DECIMAL(18,4) NOT NULL,
    "market_value" DECIMAL(20,4),
    "cost_price" DECIMAL(18,6),
    "average_cost" DECIMAL(18,6),
    "current_price" DECIMAL(18,6),
    "currency" VARCHAR(8),
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL,
    "opened_at" TIMESTAMPTZ(6) NOT NULL,
    "opened_at_source" VARCHAR(8) NOT NULL,
    "synced_at" TIMESTAMPTZ(6) NOT NULL,
    "raw" JSONB NOT NULL,

    CONSTRAINT "broker_position_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "optionsdesk"."broker_deal" (
    "id" BIGSERIAL NOT NULL,
    "account_id" BIGINT NOT NULL,
    "connection_id" BIGINT NOT NULL,
    "market" VARCHAR(4) NOT NULL,
    "deal_id" VARCHAR(64) NOT NULL,
    "order_id" VARCHAR(64),
    "code" VARCHAR(64) NOT NULL,
    "underlying_ticker" VARCHAR(32),
    "side" VARCHAR(16) NOT NULL,
    "qty" DECIMAL(18,4) NOT NULL,
    "price" DECIMAL(18,6) NOT NULL,
    "currency" VARCHAR(8) NOT NULL,
    "traded_at" TIMESTAMPTZ(6) NOT NULL,
    "raw" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "broker_deal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "optionsdesk"."broker_order" (
    "id" BIGSERIAL NOT NULL,
    "account_id" BIGINT NOT NULL,
    "connection_id" BIGINT NOT NULL,
    "market" VARCHAR(4) NOT NULL,
    "order_id" VARCHAR(64) NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "combo_leg_codes" TEXT[],
    "underlying_ticker" VARCHAR(32),
    "side" VARCHAR(16) NOT NULL,
    "order_type" VARCHAR(32),
    "qty" DECIMAL(18,4) NOT NULL,
    "price" DECIMAL(18,6),
    "status" VARCHAR(32) NOT NULL,
    "currency" VARCHAR(8),
    "vendor_created_at" TIMESTAMPTZ(6),
    "vendor_updated_at" TIMESTAMPTZ(6) NOT NULL,
    "raw" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "broker_order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "optionsdesk"."broker_contract_ref" (
    "market" VARCHAR(4) NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "underlying_ticker" VARCHAR(32) NOT NULL,
    "source" VARCHAR(16) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_broker_contract_ref" PRIMARY KEY ("market","code")
);

-- CreateTable
CREATE TABLE "optionsdesk"."broker_sync_run" (
    "id" BIGSERIAL NOT NULL,
    "account_id" BIGINT NOT NULL,
    "connection_id" BIGINT NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "market" VARCHAR(4),
    "target" VARCHAR(32) NOT NULL,
    "window_start" TIMESTAMPTZ(6),
    "window_end" TIMESTAMPTZ(6),
    "trading_date" DATE,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "first_attempted_at" TIMESTAMPTZ(6),
    "next_attempt_at" TIMESTAMPTZ(6),
    "written" INTEGER,
    "filled" INTEGER,
    "error" VARCHAR(512),
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "source_event_id" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "broker_sync_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ix_broker_connection_account" ON "optionsdesk"."broker_connection"("account_id");

-- CreateIndex
CREATE INDEX "ix_broker_position_account_market" ON "optionsdesk"."broker_position"("account_id", "market");

-- CreateIndex
CREATE UNIQUE INDEX "uk_broker_position_connection_market_code" ON "optionsdesk"."broker_position"("connection_id", "market", "code");

-- CreateIndex
CREATE INDEX "ix_broker_deal_account_market" ON "optionsdesk"."broker_deal"("account_id", "market");

-- CreateIndex
CREATE UNIQUE INDEX "uk_broker_deal_connection_deal" ON "optionsdesk"."broker_deal"("connection_id", "deal_id");

-- CreateIndex
CREATE INDEX "ix_broker_order_account_market" ON "optionsdesk"."broker_order"("account_id", "market");

-- CreateIndex
CREATE UNIQUE INDEX "uk_broker_order_connection_order" ON "optionsdesk"."broker_order"("connection_id", "order_id");

-- CreateIndex
CREATE INDEX "ix_broker_sync_run_account_market" ON "optionsdesk"."broker_sync_run"("account_id", "market");

-- CreateIndex
CREATE UNIQUE INDEX "uk_broker_sync_run_connection_source_event" ON "optionsdesk"."broker_sync_run"("connection_id", "source_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "uk_broker_sync_run_reconcile_active" ON "optionsdesk"."broker_sync_run"("connection_id", "market", "trading_date") WHERE (((kind)::text = 'reconcile'::text) AND ((status)::text = ANY ((ARRAY['running'::character varying, 'succeeded'::character varying])::text[])));
