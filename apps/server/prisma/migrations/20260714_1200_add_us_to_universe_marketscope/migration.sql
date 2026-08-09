-- S2-T3 seam: universe 维度 market_scope 从 {cn,hk} 扩到 {cn,hk,us} — 激活 us 枚举总开关
-- (SyncUniverseUseCase 读 universe.market_scope 驱动 enumerate; 含 us 时 UniverseFallbackChain
-- per-market fallback 走东财备源枚举美股全集。其余富化维度**不加 us** —— 无 us 富化 vendor,
-- 加了 loadActiveInstruments 也白选, us 完整行情/基本面管线 = 后续里程碑, 本 plan out-of-scope)。
-- 幂等 WHERE (dimension_key='universe', 重 deploy 同值覆盖零副作用); expand/data-only, 非破坏性
-- → 单 PR 合规 (ADR-0035 + migration-rules.md §2/§3; market_scope 列已存在, 纯 data-only)。
-- migration_refs: docs/plans/2026-07/07-14-marketdata-trading-day-multimarket-master.md (Sub-plan 2 S2-T3)

UPDATE "marketdata"."sync_dimension"
  SET "market_scope" = ARRAY['cn', 'hk', 'us'], "updated_at" = now()
  WHERE "dimension_key" = 'universe';
