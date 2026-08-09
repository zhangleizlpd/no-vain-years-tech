-- 019 T015 扫描节奏 + 批量调大 (PR-4, US2 预算账载体):
--   ① corporate_action cron 改周频扫描 (周一 22:00 — slow-drift 扫描即同步, analyze C1;
--      日频 5,600 → 周频摊 ~800/日);
--   ② financial 改周二 22:00 周扫 (T001 探测 fallback 形态: 无市场级披露日历端点 →
--      slow-drift latest 比对, 与 corp 错峰);
--   ③ fundamental/financial batch_size 1 → 100 (T001 实测安全上限: size 100 OK, 200 →
--      HTTP 400; fundamental 5,600 → 56 请求/日, financial 周扫 56 请求/次)。
-- 幂等 UPDATE (重 deploy 安全)。universe 已周一周扫 (017), eod/fundamental cron 不动。
-- migration_refs: specs/019-marketdata-sync-strategy (US2 扫描节奏; SC-S01 预算账)。

UPDATE "marketdata"."sync_dimension" SET "cron_expr" = '0 0 22 * * 1'
  WHERE "dimension_key" = 'corporate_action';
UPDATE "marketdata"."sync_dimension" SET "cron_expr" = '0 0 22 * * 2'
  WHERE "dimension_key" = 'financial';
UPDATE "marketdata"."sync_dimension" SET "batch_size" = 100
  WHERE "dimension_key" IN ('fundamental', 'financial');
