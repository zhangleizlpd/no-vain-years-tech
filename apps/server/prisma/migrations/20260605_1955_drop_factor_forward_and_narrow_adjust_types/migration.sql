-- 020 T010 contract 段 (D6 expand→contract 两段时序; expand = 20260605_1850):
-- factor_forward 全仓零消费者后 DROP — 读时换算只消费 factor_backward (per-event 跃变
-- f_i, 模型改判后比值口径); 旧段内比值锚定写者已随 T009 退役。
ALTER TABLE "marketdata"."adjustment_factor" DROP COLUMN "factor_forward";

-- 配置收窄 (clarify ③, FR-A01): eod_bar 写路径只落 none 单口径 — adjust_types 语义
-- deprecated (恒 {none}, 列保留); 幂等 UPDATE。
UPDATE "marketdata"."sync_dimension"
SET "adjust_types" = '{none}'
WHERE "dimension_key" = 'eod_bar';
