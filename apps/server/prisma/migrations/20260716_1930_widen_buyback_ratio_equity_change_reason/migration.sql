-- 加宽 2 列，修 2 只港股回填时 schema 精度撑爆的溢出 bug：
--   1. buyback_event.ratio_purchased_since_resolution: numeric(10,6) → numeric(20,6)
--      hk:06603 的「决议以来已购回比率」值 ≥10000 → 原 4 位整数精度不够 → numeric field overflow。
--   2. equity_change.change_reason: varchar(64) → varchar (无界)
--      hk:09688 (快手) 的「股本变动原因」文本 >64 字符 → value too long。
--      改无界与同表/同族文本列 (method_of_purchase / currency) 一致。
-- expand-only: 仅 2 条 ALTER COLUMN ... SET DATA TYPE，非破坏性 (放宽精度/长度，不丢数据)
--   → 单 PR 合规 (ADR-0035 + migration-rules.md §2)。
-- DDL 由 `prisma migrate diff --from-config-datasource --to-schema` 从 schema.prisma 生成 (零 drift)，
--   剔除 diff 误报的 `DROP INDEX ix_instrument_pinyin_abbr_trgm` (pg_trgm GIN 索引 schema.prisma 无法建模，
--   属既有 committed 索引 20260602_1430，本 migration 不触 — 同 043/044 先例)。
-- migration_refs: fix/marketdata-buyback-equity-change-column-widen

-- AlterTable
ALTER TABLE "marketdata"."buyback_event" ALTER COLUMN "ratio_purchased_since_resolution" SET DATA TYPE DECIMAL(20,6);

-- AlterTable
ALTER TABLE "marketdata"."equity_change" ALTER COLUMN "change_reason" SET DATA TYPE VARCHAR;
