-- 注: prisma migrate dev 误生成的 `DROP INDEX ix_instrument_pinyin_abbr_trgm` 已剔除 —
-- 该 GIN 三元组拼音索引由 raw SQL migration 建 (20260602_1430, prisma schema 表达不了),
-- prisma 不认识非要删它 (与 20260614_1056_chat_init 同处置)。

-- AlterTable
-- 030 plan D6: Message.metadata 加性可空 (旧消息 null = 无联网, 正常渲染)。
ALTER TABLE "chat"."message" ADD COLUMN     "metadata" JSONB;
