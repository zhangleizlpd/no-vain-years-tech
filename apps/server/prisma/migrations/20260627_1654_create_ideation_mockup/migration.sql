-- 注: prisma migrate dev 误生成的 `DROP INDEX ix_instrument_pinyin_abbr_trgm` 已剔除 —
-- 该 GIN 三元组拼音索引由 raw SQL migration 建 (20260602_1430, prisma schema 表达不了),
-- prisma 不认识非要删它 (本 wrapper scripts/prisma-migrate.ts 自动剔除)。

-- CreateTable
CREATE TABLE "ideation"."ideation_mockup" (
    "id" BIGSERIAL NOT NULL,
    "session_id" BIGINT NOT NULL,
    "account_id" BIGINT NOT NULL,
    "object_key" TEXT NOT NULL,
    "screens" JSONB NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ideation_mockup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ix_idea_mockup_session_created" ON "ideation"."ideation_mockup"("session_id", "created_at");

-- CreateIndex
CREATE INDEX "ix_idea_mockup_account" ON "ideation"."ideation_mockup"("account_id");
