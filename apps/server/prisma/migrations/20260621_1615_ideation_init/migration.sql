-- 注: prisma migrate dev 误生成的 `DROP INDEX ix_instrument_pinyin_abbr_trgm` 已剔除 —
-- 该 GIN 三元组拼音索引由 raw SQL migration 建 (20260602_1430, prisma schema 表达不了),
-- prisma 不认识非要删它 (与 20260614_1056_chat_init / 20260619_0900_add_chat_preference_table 同处置)。

-- 032 ADR-0057: 需求灵感澄清 (ideation 第 8 bounded context, 叶子)。3 表 + ideation schema,
-- 加性安全迁移 (无破坏性变更; accountId/sessionId 逻辑引用无 FK per ADR-0043)。

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "ideation";

-- CreateTable
CREATE TABLE "ideation"."idea_session" (
    "id" BIGSERIAL NOT NULL,
    "account_id" BIGINT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "repo" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idea_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ideation"."idea_turn" (
    "id" BIGSERIAL NOT NULL,
    "session_id" BIGINT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "suggestion" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idea_turn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ideation"."requirements_draft" (
    "id" BIGSERIAL NOT NULL,
    "session_id" BIGINT NOT NULL,
    "brief_json" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "requirements_draft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ix_idea_session_account_updated" ON "ideation"."idea_session"("account_id", "updated_at");

-- CreateIndex
CREATE INDEX "ix_idea_turn_session_id" ON "ideation"."idea_turn"("session_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "requirements_draft_session_id_key" ON "ideation"."requirements_draft"("session_id");
