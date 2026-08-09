-- 022 alert 推送送达 (plan D2/D3): push_binding (EP9/EP10 绑定) + push_delivery
-- (alert 自有 transactional outbox 兼留痕 ledger)。accountId / triggerId 均逻辑引用
-- 无 FK (021 体例)。
-- 注: 上游 ix_instrument_pinyin_abbr_trgm 为 raw-SQL GIN 索引 (20260602_1430),
-- Prisma 表达不了, migrate dev 自动生成的 DROP 已手工移除 — 后续 migrate dev 同坑注意。

-- CreateTable
CREATE TABLE "alert"."push_binding" (
    "id" BIGSERIAL NOT NULL,
    "account_id" BIGINT NOT NULL,
    "registration_id" VARCHAR(64) NOT NULL,
    "platform" VARCHAR(16) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_binding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert"."push_delivery" (
    "id" BIGSERIAL NOT NULL,
    "trigger_id" BIGINT NOT NULL,
    "account_id" BIGINT NOT NULL,
    "registration_id" VARCHAR(64) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6),
    "last_error" VARCHAR(256),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ(6),

    CONSTRAINT "push_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uk_push_binding_registration_id" ON "alert"."push_binding"("registration_id");

-- CreateIndex
CREATE INDEX "ix_push_binding_account" ON "alert"."push_binding"("account_id");

-- CreateIndex
CREATE INDEX "ix_push_delivery_status_next_attempt" ON "alert"."push_delivery"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "ix_push_delivery_trigger" ON "alert"."push_delivery"("trigger_id");
