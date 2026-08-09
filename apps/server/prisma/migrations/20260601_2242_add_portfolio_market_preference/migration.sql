-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "portfolio";

-- CreateTable
CREATE TABLE "portfolio"."market_preference" (
    "id" BIGSERIAL NOT NULL,
    "account_id" BIGINT NOT NULL,
    "market" VARCHAR(8) NOT NULL,
    "active" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "market_preference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uk_market_preference_account_market" ON "portfolio"."market_preference"("account_id", "market");
