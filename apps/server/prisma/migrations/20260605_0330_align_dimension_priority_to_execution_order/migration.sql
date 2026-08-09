-- 019 T005 priority 调值 (PR-2, 行为保持重构的 seed 半): 全序常量退役 → 由依赖边拓扑
-- 派生 + priority tie-break。现 seed eod_bar=8 > fundamental=7 与 017 常量序
-- (fundamental → financial → eod_bar) 矛盾 — 调齐使派生序 ≡ 旧常量序 (IT 对拍断言):
--   universe 10 / profile 9 / fundamental 8 / financial 7 / eod_bar 6 / corporate_action 5
-- 幂等 UPDATE (重 deploy 安全); 不加依赖边 (D8 雷区: hard corp→eod 归 PR-3 T011)。
-- migration_refs: specs/019-marketdata-sync-strategy (US3 拓扑派生; FR-S07)。

UPDATE "marketdata"."sync_dimension" SET "priority" = 8 WHERE "dimension_key" = 'fundamental';
UPDATE "marketdata"."sync_dimension" SET "priority" = 7 WHERE "dimension_key" = 'financial';
UPDATE "marketdata"."sync_dimension" SET "priority" = 6 WHERE "dimension_key" = 'eod_bar';
