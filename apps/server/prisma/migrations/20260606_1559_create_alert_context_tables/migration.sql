-- 021 alert 第 6 bounded context (ADR-0052): 4 表自持。
-- accountId / (market, code) 均为逻辑引用 (跨 schema 禁 FK); alert_condition→alert
-- 为同 schema intra FK Cascade; alert_trigger.alert_id 普通列无 FK (流水独立生命周期)。

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "alert";

-- CreateTable
CREATE TABLE "alert"."alert" (
    "id" BIGSERIAL NOT NULL,
    "account_id" BIGINT NOT NULL,
    "market" VARCHAR(4) NOT NULL,
    "code" VARCHAR(16) NOT NULL,
    "frequency" VARCHAR(16) NOT NULL DEFAULT 'DAILY',
    "note" VARCHAR(64),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert"."alert_condition" (
    "id" BIGSERIAL NOT NULL,
    "alert_id" BIGINT NOT NULL,
    "type" VARCHAR(16) NOT NULL,
    "threshold" DECIMAL(18,4) NOT NULL,

    CONSTRAINT "alert_condition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert"."alert_trigger" (
    "id" BIGSERIAL NOT NULL,
    "alert_id" BIGINT,
    "account_id" BIGINT NOT NULL,
    "market" VARCHAR(4) NOT NULL,
    "code" VARCHAR(16) NOT NULL,
    "instrument_name" VARCHAR(128) NOT NULL,
    "trade_date" DATE NOT NULL,
    "conditions_snapshot" JSONB NOT NULL,
    "frequency_snapshot" VARCHAR(16) NOT NULL,
    "note_snapshot" VARCHAR(64),
    "triggered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alert_trigger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert"."alert_read_cursor" (
    "account_id" BIGINT NOT NULL,
    "last_read_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "alert_read_cursor_pkey" PRIMARY KEY ("account_id")
);

-- CreateIndex
CREATE INDEX "ix_alert_account_market_code" ON "alert"."alert"("account_id", "market", "code");

-- CreateIndex
CREATE INDEX "ix_alert_enabled" ON "alert"."alert"("enabled");

-- CreateIndex
CREATE UNIQUE INDEX "uk_alert_condition_alert_type" ON "alert"."alert_condition"("alert_id", "type");

-- CreateIndex
CREATE INDEX "ix_alert_trigger_account_triggered" ON "alert"."alert_trigger"("account_id", "triggered_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "uk_alert_trigger_alert_tradedate" ON "alert"."alert_trigger"("alert_id", "trade_date");

-- AddForeignKey
ALTER TABLE "alert"."alert_condition" ADD CONSTRAINT "alert_condition_alert_id_fkey" FOREIGN KEY ("alert_id") REFERENCES "alert"."alert"("id") ON DELETE CASCADE ON UPDATE CASCADE;
