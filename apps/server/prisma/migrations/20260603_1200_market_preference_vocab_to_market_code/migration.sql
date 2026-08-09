-- 词表对齐 015 Instrument.market: portfolio_preference.active_markets 内的币种码 → 小写市场码。
-- 011 catalog marketCode 由 CNY/HKD/USD 改 cn/hk/us（与 015 canonical `cn:600519` 同词表,
-- 全仓不做币种↔市场码映射）; isoCurrency 字段独立保留供 UI 显示。
-- 数据迁移（无 schema 列变更）: pre-内测 近空表 → 安全 in-place。仅核心 3 码会出现在
-- active_markets（海外不可激活, 不入此列）, 故只映射 cn/hk/us; WHERE 限定含旧码行（幂等）。

UPDATE "portfolio"."portfolio_preference"
SET "active_markets" = ARRAY(
  SELECT CASE m
    WHEN 'CNY' THEN 'cn'
    WHEN 'HKD' THEN 'hk'
    WHEN 'USD' THEN 'us'
    ELSE m
  END
  FROM unnest("active_markets") AS m
)
WHERE "active_markets" && ARRAY['CNY', 'HKD', 'USD'];
