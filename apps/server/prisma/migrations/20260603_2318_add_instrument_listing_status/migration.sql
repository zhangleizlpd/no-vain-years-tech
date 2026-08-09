-- universe 富化: Instrument 加 listing_status 列 (理杏仁 /cn/company 原始 listingStatus 值,
-- 如 normally_listed / special_treatment(ST) / delisting_risk_warning(*ST) / ...)。保留原始值
-- 以便审计 + 前端展示 ST/*ST 风险徽标 + 改映射策略不重 sync; 转换后的 active/inactive 落既有
-- status 列驱动 loadActiveInstruments 同步过滤。东财备源 (clist listed-only) 无此概念 → NULL。
-- additive nullable 列 = expand-only 非破坏性 (migration-rules.md §2 不适用三步法)。
-- migration_refs: specs/016-marketdata-sync (universe 源切理杏仁 per ADR-0047 Amendment 2026-06-03)。

ALTER TABLE "marketdata"."instrument" ADD COLUMN "listing_status" VARCHAR(32);
