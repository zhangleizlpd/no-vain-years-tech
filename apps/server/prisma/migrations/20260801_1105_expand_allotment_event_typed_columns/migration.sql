-- 配股事件 typed 列提列 (兑现 041 plan Decision 5 的「首个真实非空样本后可 expand 提列」)。
--
-- 041 建表时 probe 扫 12 标的全 0 行, 按「港股配股零样本 / 字段 schema 未知」整存 payload Json。
-- 该前提 2026-08-01 证伪: prod 已有 545 行真实样本, 字段固定为
--   date / exDate / allotmentRatio / allotmentPrice / allotmentShares / currency
--
-- 提列动机 = 复权因子改用业内标准除权价公式 (CRSP CFACPR / Tushare adj_factor 同源):
--   除权价 = (前收 + 配股价×配股比率 − 每股派息) / (1 + 配股比率 + 送股比率)
-- 分子的 `P·q` 与分母的 `1 + q` 直接来自本表, 金融数值走 Decimal 列而非 JSON 文本
-- (JSON 无类型/无精度保障, 且 `->>` 取值再 cast 在查询侧无法建索引)。
--
-- 🚨 `date` 是**公告日**不是除权日: 545 行实测 510 行两者不同, 35 行 vendor 无 exDate。
-- 因子按除权日定版本边界 ⇒ 新增 ix_allotment_event_instrument_exdate 支撑按 exDate 关联。
-- 自然键仍是 (instrument_id, date) —— exDate 可空且可改期, 不适合做键 (per migration-rules §4:
-- 可空列不进唯一约束)。
--
-- 纯 additive: 4 个 nullable 列 + 1 个索引 + 存量回填, 无删列/改列/改约束 ⇒ 不触发
-- expand-migrate-contract 三步法 (migration-rules §2 只约束破坏性变更)。旧代码读不到新列
-- 亦不受影响 (payload 原样保留, 无损兜底)。

ALTER TABLE "marketdata"."allotment_event"
  ADD COLUMN "ex_date"          DATE,
  ADD COLUMN "allotment_ratio"  DECIMAL(18, 8),
  ADD COLUMN "allotment_price"  DECIMAL(18, 4),
  ADD COLUMN "currency"         VARCHAR(8);

-- 存量回填: 数据本就完整躺在 payload 里, 无需重新外呼 vendor。
-- vendor 日期是带时区的 ISO datetime (`2026-08-18T00:00:00+08:00`) → 取前 10 位即 HK 日历日
-- (与 adapter 的 lixDateOnly 同口径; 该端点 payload 实测均为 +08:00 而非 UTC-Z, 无 off-by-one)。
-- 数值字段 vendor 下发 JSON number → `->>` 得十进制字面量, 直接 cast 不经 float 中转。
UPDATE "marketdata"."allotment_event" SET
  "ex_date" = CASE
                WHEN "payload" ->> 'exDate' IS NULL THEN NULL
                ELSE (left("payload" ->> 'exDate', 10))::date
              END,
  "allotment_ratio" = ("payload" ->> 'allotmentRatio')::numeric,
  "allotment_price" = ("payload" ->> 'allotmentPrice')::numeric,
  "currency"        = "payload" ->> 'currency';

CREATE INDEX "ix_allotment_event_instrument_exdate"
  ON "marketdata"."allotment_event" ("instrument_id", "ex_date");
