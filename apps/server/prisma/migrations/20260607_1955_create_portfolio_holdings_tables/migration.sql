-- CreateTable
CREATE TABLE "portfolio"."holding" (
    "id" BIGSERIAL NOT NULL,
    "account_id" BIGINT NOT NULL,
    "market" VARCHAR(4) NOT NULL,
    "code" VARCHAR(16) NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "qty" DECIMAL(18,4) NOT NULL,
    "unit_cost" DECIMAL(18,6) NOT NULL,
    "weight_pct" DECIMAL(8,4),
    "hold_days" INTEGER,
    "cum_pnl" DECIMAL(18,2),
    "cum_pnl_pct" DECIMAL(10,4),
    "quotable" BOOLEAN NOT NULL,
    "as_of" DATE NOT NULL,
    "raw" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "holding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "portfolio"."closed_position" (
    "id" BIGSERIAL NOT NULL,
    "account_id" BIGINT NOT NULL,
    "market" VARCHAR(4) NOT NULL,
    "code" VARCHAR(16) NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "open_date" DATE NOT NULL,
    "close_date" DATE NOT NULL,
    "buy_avg" DECIMAL(18,4) NOT NULL,
    "sell_avg" DECIMAL(18,4) NOT NULL,
    "total_pnl" DECIMAL(18,2) NOT NULL,
    "total_pnl_pct" DECIMAL(10,4),
    "fee" DECIMAL(18,2),
    "index_pct" DECIMAL(10,4),
    "vs_index_pct" DECIMAL(10,4),
    "raw" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "closed_position_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "portfolio"."trade_record" (
    "id" BIGSERIAL NOT NULL,
    "account_id" BIGINT NOT NULL,
    "market" VARCHAR(4),
    "code" VARCHAR(16),
    "name" VARCHAR(128),
    "category" VARCHAR(16) NOT NULL,
    "trade_date" DATE NOT NULL,
    "trade_time" VARCHAR(8),
    "qty" DECIMAL(18,4),
    "price" DECIMAL(18,6),
    "amount" DECIMAL(18,2) NOT NULL,
    "turnover" DECIMAL(18,2),
    "fee" DECIMAL(18,2),
    "note" VARCHAR(256),
    "raw" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trade_record_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uk_holding_account_market_code" ON "portfolio"."holding"("account_id", "market", "code");

-- CreateIndex
CREATE INDEX "ix_closedposition_account_market_code" ON "portfolio"."closed_position"("account_id", "market", "code");

-- CreateIndex
CREATE INDEX "ix_traderecord_account_market_code_date" ON "portfolio"."trade_record"("account_id", "market", "code", "trade_date");
