-- universe 同步降频: cronExpr daily → weekly 周一 (减东财 clist 风控暴露 — 0.3.0 上线实跑撞东财
-- IP 风控后的缓解 option C)。per-dimension cronExpr seam 已实装 (eod-sync-pipeline
-- loadEnabledDimensions: delta 按 cronExpr「今日 due」门控, backfill 不受限)。周一 = 交易日
-- (避周末/非交易星期被外层交易日 gate 短路致永不跑)。data-only UPDATE, 幂等, 非破坏性 →
-- 单 PR 合规 (ADR-0035 + migration-rules.md §2)。
-- migration_refs: specs/016-marketdata-sync (FR-S16 配置驱动 cronExpr)。

UPDATE "marketdata"."sync_dimension"
  SET "cron_expr" = '0 0 22 * * 1', "updated_at" = now()
  WHERE "dimension_key" = 'universe';
