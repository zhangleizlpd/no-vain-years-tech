-- 官方涨跌幅 (百分数, 已含除权除息调整) — 理杏仁 ex_rights `change`×100。复权不变量。
-- nullable additive expand: 旧行 NULL, 读侧 changePct 缺失时回退 computeChange(close, prevClose)。
-- 注: prisma migrate dev 误生成的 `DROP INDEX ix_instrument_pinyin_abbr_trgm` 已剔除 —
-- 该 GIN 三元组拼音索引由 raw SQL migration 建 (prisma schema 表达不了), prisma 不认识非要删它。
ALTER TABLE "marketdata"."daily_bar" ADD COLUMN "change_pct" DECIMAL(10,4);
