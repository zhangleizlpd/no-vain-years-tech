-- 072: 系统管理员标。面向锚待审箱审批等**系统维护面**的准入,与业务数据归属正交。
--
-- expand-only:NOT NULL DEFAULT false 在 PG 11+ 是 metadata-only(无表重写),且 DDL 默认值让
-- 旧镜像的 INSERT 照样合法 ⇒ 满足 prod image-only 回滚的前提(回滚只换 tag、不回退 schema)。
--
-- 🚨 本文件**不含任何 seed**:提权按 account id 手工执行(见 schema.prisma 该列注释),
--    手机号是 PII、不进仓;「哪个账号是 admin」这个状态也不进仓。
ALTER TABLE "account"."account"
  ADD COLUMN "is_admin" BOOLEAN NOT NULL DEFAULT false;
