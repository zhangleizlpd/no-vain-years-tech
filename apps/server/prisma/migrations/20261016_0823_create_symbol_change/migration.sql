-- 注: prisma migrate dev 误生成的 `DROP INDEX ix_instrument_pinyin_abbr_trgm` 已剔除 —
-- 该 GIN 三元组拼音索引由 raw SQL migration 建 (20260602_1430, prisma schema 表达不了),
-- prisma 不认识非要删它 (本 wrapper scripts/prisma-migrate.ts 自动剔除)。

-- CreateTable
CREATE TABLE "marketdata"."symbol_change" (
    "id" BIGSERIAL NOT NULL,
    "market" VARCHAR(8) NOT NULL,
    "old_code" VARCHAR(16) NOT NULL,
    "new_code" VARCHAR(16) NOT NULL,
    "effective_date" DATE NOT NULL,
    "event_type" VARCHAR(16) NOT NULL,
    "source" VARCHAR(16) NOT NULL,
    "evidence" TEXT NOT NULL,
    "registered_by" VARCHAR(64) NOT NULL,
    "registered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by" VARCHAR(64),
    "revoke_reason" TEXT,

    CONSTRAINT "symbol_change_pkey" PRIMARY KEY ("id")
);

-- 086 T001 部分唯一索引 (FR-002 / FR-003; plan D1)。设计意图 SoT = schema.prisma 的 SymbolChange
-- 段头注释, 此处不镜像字段表。谓词**只含 `revoked_at IS NULL`**: 撤销后同一组
-- (market, old_code, effective_date) 允许重新登记; 去掉谓词会让撤销过的登记再也登不回来。
-- 零改既有表, image-only 回滚安全 (旧镜像不读本表)。

-- CreateIndex
CREATE UNIQUE INDEX "uk_symbol_change_active" ON "marketdata"."symbol_change"("market", "old_code", "effective_date") WHERE ("revoked_at" IS NULL);
