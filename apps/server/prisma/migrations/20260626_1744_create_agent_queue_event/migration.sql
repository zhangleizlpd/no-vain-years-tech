-- 注: prisma migrate dev 误生成的 `DROP INDEX ix_instrument_pinyin_abbr_trgm` 已剔除 —
-- 该 GIN 三元组拼音索引由 raw SQL migration 建 (20260602_1430, prisma schema 表达不了),
-- prisma 不认识非要删它 (与 20260614_1056_chat_init / 20260619_0900_add_chat_preference_table 同处置)。

-- CreateTable: App→本地 agent 通用事件队列 (agent-bridge 模块; 瘦事件 claim-check + 状态机 + 租约)。
CREATE TABLE "agent_queue_event" (
    "id" UUID NOT NULL,
    "account_id" BIGINT NOT NULL,
    "biz_type" TEXT NOT NULL,
    "biz_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "source_event_id" UUID,
    "claimed_at" TIMESTAMPTZ(6),
    "lease_expires_at" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "result" JSONB,
    "done_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "agent_queue_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: at-least-once 去重闸 (上游 outbox event id 唯一)。
CREATE UNIQUE INDEX "uk_agent_queue_event_source_event_id" ON "agent_queue_event"("source_event_id");

-- CreateIndex: poll 扫 claimable FIFO (status, created_at)。
CREATE INDEX "agent_queue_event_claimable_idx" ON "agent_queue_event"("status", "created_at");

-- CreateIndex: per-account 队列上限计数 (account_id, status)。
CREATE INDEX "agent_queue_event_account_idx" ON "agent_queue_event"("account_id", "status");
