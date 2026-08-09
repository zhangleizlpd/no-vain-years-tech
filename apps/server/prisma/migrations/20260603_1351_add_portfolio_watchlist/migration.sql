-- 013 自选列表 (portfolio 第 3 组 operation)。expand-only: CREATE 2 TABLE + FK
-- (group↔item 同 portfolio schema 内 intra FK, 允许) + unique/index, 非破坏性 →
-- 单 PR 合规 (ADR-0035 + migration-rules.md §2)。datasource schemas 已含 portfolio
-- (011 立), 无需 CREATE SCHEMA。
-- uk_group_account_systemkind = 每账号每系统组 ≤1 (custom systemKind=NULL 不约束,
-- PG 多 NULL 不冲突)。uk_watchlistitem_group_market_code = 组内同标的唯一 (幂等加)。

-- CreateTable
CREATE TABLE "portfolio"."group" (
    "id" BIGSERIAL NOT NULL,
    "account_id" BIGINT NOT NULL,
    "name" VARCHAR(40) NOT NULL,
    "type" VARCHAR(8) NOT NULL,
    "system_kind" VARCHAR(12),
    "visible" BOOLEAN NOT NULL DEFAULT true,
    "order" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "portfolio"."watchlist_item" (
    "id" BIGSERIAL NOT NULL,
    "group_id" BIGINT NOT NULL,
    "market" VARCHAR(4) NOT NULL,
    "code" VARCHAR(16) NOT NULL,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "order" INTEGER NOT NULL,
    "color" VARCHAR(16),
    "note_ref" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "watchlist_item_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uk_group_account_systemkind" ON "portfolio"."group"("account_id", "system_kind");

-- CreateIndex
CREATE INDEX "ix_group_account_order" ON "portfolio"."group"("account_id", "order");

-- CreateIndex
CREATE UNIQUE INDEX "uk_watchlistitem_group_market_code" ON "portfolio"."watchlist_item"("group_id", "market", "code");

-- CreateIndex
CREATE INDEX "ix_watchlistitem_group_pin_order" ON "portfolio"."watchlist_item"("group_id", "pinned", "order");

-- AddForeignKey
ALTER TABLE "portfolio"."watchlist_item" ADD CONSTRAINT "watchlist_item_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "portfolio"."group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
