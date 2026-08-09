-- 原批 E (realname 实名认证) 于 2026-05-31 废弃,不再迁
-- (见 docs/plans/2026-05/05-25-account-migration-p2-usecase-dependency.md / master)。
-- `realname_profile` 表由 W1.4 `prisma db pull` 从旧 Java/Spring 反推入 schema,
-- 但 realname 三 use case (Initiate / Confirm / Query) 从未迁移 —— 该表无任何写入方,
-- 始终为空表,无业务数据。
--
-- 破坏性变更 (drop table) 跳过 expand-migrate-contract 三步法,理由
-- (per ADR-0035 § 数据层治理 / .claude/rules/migration-rules.md § 3 跳步条件):
--   1. 无真实用户数据:M3 内测前 dev/staging,且 realname_profile 始终为空 (无 use case 写入)。
--   2. 无应用代码引用 (零 non-generated 消费方),无滚动部署旧实例读旧字段风险。
-- 一次性 destructive cleanup;user-authorized 2026-05-31。

DROP TABLE IF EXISTS "account"."realname_profile" CASCADE;
