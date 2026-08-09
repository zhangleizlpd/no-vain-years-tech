-- 012 券商账户绑定 (portfolio 第 2 组 operation)。expand-only: 仅 CREATE TABLE +
-- unique + index, 非破坏性 → 单 PR 合规 (ADR-0035 + migration-rules.md §2)。
-- datasource schemas 已含 portfolio (011 立), 无需 CREATE SCHEMA。
-- 唯一索引 (account_id, broker_code, client_no) = dup 兜底 + 并发同键插入串行点 (D1)。

-- CreateTable
CREATE TABLE "portfolio"."broker_account" (
    "id" BIGSERIAL NOT NULL,
    "account_id" BIGINT NOT NULL,
    "broker_code" VARCHAR(32) NOT NULL,
    "client_no" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "broker_account_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uk_broker_account_acct_broker_client" ON "portfolio"."broker_account"("account_id", "broker_code", "client_no");

-- CreateIndex
CREATE INDEX "ix_broker_account_account" ON "portfolio"."broker_account"("account_id");
