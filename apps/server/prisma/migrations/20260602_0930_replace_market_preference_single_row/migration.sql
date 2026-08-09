-- ADR-0046: market_preference(行/市场) → portfolio_preference(单行 active_markets text[])。
-- 跨行 min-1 不变性塌缩成单行非空 → 去 FOR UPDATE + 去 materialize。
-- 破坏性变更(拆表)单 PR 跳过 expand-migrate-contract：011 无 prod 数据(pre-内测),
-- per migration-rules.md §3 跳步条件 → 纯 drop+create swap,无行→array 数据迁移。

DROP TABLE "portfolio"."market_preference";

CREATE TABLE "portfolio"."portfolio_preference" (
    "account_id" BIGINT NOT NULL,
    "active_markets" TEXT[] NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "portfolio_preference_pkey" PRIMARY KEY ("account_id")
);
