-- 复权重取回溯上限提为 SyncDimension 策略字段 (FR-S16, 配置驱动; 原 pipeline 硬编码 730 常量)。
-- expand-only: 仅 ADD COLUMN (nullable) + seed corporate_action 维度默认 730 → 非破坏性, 单 PR
-- 合规 (ADR-0035 + migration-rules.md §2)。pipeline 读 `re_adjust_lookback_days ?? 730` (兜底)。
-- migration_refs: specs/016-marketdata-sync (FR-S11 复权重取 / FR-S16 配置驱动 strategy 字段)。

ALTER TABLE "marketdata"."sync_dimension" ADD COLUMN "re_adjust_lookback_days" INTEGER;

-- corporate_action 维度持有复权重取策略 (它是触发方); 默认 730 天 (≈2yr, 覆盖常用复权窗口)。
UPDATE "marketdata"."sync_dimension"
  SET "re_adjust_lookback_days" = 730
  WHERE "dimension_key" = 'corporate_action';
