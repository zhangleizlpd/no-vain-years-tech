-- 注: prisma migrate dev 误生成的 `DROP INDEX ix_instrument_pinyin_abbr_trgm` 已剔除 —
-- 该 GIN 三元组拼音索引由 raw SQL migration 建 (20260602_1430, prisma schema 表达不了),
-- prisma 不认识非要删它 (本 wrapper scripts/prisma-migrate.ts 自动剔除)。

-- 086 T017 疑似改名候选表 (FR-018; plan D8)。设计意图 SoT = schema.prisma 的 SymbolChangeCandidate
-- 段头注释, 此处不镜像字段表。部分唯一索引由 schema `@@unique(..., where: raw(...))` 声明后生成。
-- 新表、零改既有表, image-only 回滚安全 (旧镜像不读本表)。

-- CreateTable
CREATE TABLE "optionsdesk"."symbol_change_candidate" (
    "id" BIGSERIAL NOT NULL,
    "ticker" VARCHAR(32) NOT NULL,
    "signal" VARCHAR(16) NOT NULL,
    "suggestions" JSONB NOT NULL,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "resolved_at" TIMESTAMPTZ(6),
    "resolution_note" TEXT,
    "symbol_change_id" BIGINT,

    CONSTRAINT "symbol_change_candidate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uk_symbol_change_candidate_pending_ticker" ON "optionsdesk"."symbol_change_candidate"("ticker") WHERE ((status)::text = 'PENDING'::text);
