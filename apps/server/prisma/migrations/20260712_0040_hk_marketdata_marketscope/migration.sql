-- 038 T003 seam#2 数据迁移 (data-only, 零 DDL): 6 个核心同步维度 market_scope 从 {cn} 扩到
-- {cn,hk} — 激活平台市场缝隙 (dimension-executor.loadActiveInstruments 据此把 market=hk 标的
-- 纳入同步工作集; market_scope 列本已存在, seed={cn}, 此前无任何读取处 = 纯休眠列)。
-- 幂等 WHERE (dimension_key IN 6 维, 重 deploy 同值覆盖零副作用); expand/data-only, 非破坏性
-- → 单 PR 合规 (ADR-0035 + migration-rules.md §2)。
-- migration_refs: specs/038-hk-marketdata-core (FR-002 marketScope 驱动工作集 / FR-003 六维扩 hk)。

UPDATE "marketdata"."sync_dimension"
  SET "market_scope" = ARRAY['cn', 'hk'], "updated_at" = now()
  WHERE "dimension_key" IN (
    'universe', 'profile', 'eod_bar', 'fundamental', 'financial', 'corporate_action'
  );
