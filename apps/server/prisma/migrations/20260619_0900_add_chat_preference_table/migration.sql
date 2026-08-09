-- 注: prisma migrate dev 误生成的 `DROP INDEX ix_instrument_pinyin_abbr_trgm` 已剔除 —
-- 该 GIN 三元组拼音索引由 raw SQL migration 建 (20260602_1430, prisma schema 表达不了),
-- prisma 不认识非要删它 (与 20260614_1056_chat_init / 20260618_1135_add_message_metadata 同处置)。

-- 031 plan D1: 账号级 chat 自定义指令偏好表 (chat 叶子 ctx 自有, 加性安全迁移)。
-- account_id 标量 unique (单账号单行, upsert 锚); custom_instruction 非空 + 默认 ''
-- (U1 null 语义收敛: 未设置 = 行不存在或空串两态等价); TEXT 不在 DB 钉 2000 (上限只在 validator 层)。
-- CreateTable
CREATE TABLE "chat"."chat_preference" (
    "id" BIGSERIAL NOT NULL,
    "account_id" BIGINT NOT NULL,
    "custom_instruction" TEXT NOT NULL DEFAULT '',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_preference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "chat_preference_account_id_key" ON "chat"."chat_preference"("account_id");
