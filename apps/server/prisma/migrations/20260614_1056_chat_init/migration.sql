-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "chat";

-- 注: prisma migrate dev 误生成的 `DROP INDEX ix_instrument_pinyin_abbr_trgm` 已剔除 —
-- 该 GIN 三元组拼音索引由 raw SQL migration 建 (prisma schema 表达不了), prisma 不认识非要删它。

-- CreateTable
CREATE TABLE "chat"."conversation" (
    "id" BIGSERIAL NOT NULL,
    "account_id" BIGINT NOT NULL,
    "title" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat"."message" (
    "id" BIGSERIAL NOT NULL,
    "conversation_id" BIGINT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ix_conversation_account_updated" ON "chat"."conversation"("account_id", "updated_at");

-- CreateIndex
CREATE INDEX "ix_message_conversation_id" ON "chat"."message"("conversation_id", "id");
