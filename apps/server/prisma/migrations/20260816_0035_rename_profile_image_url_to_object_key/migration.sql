-- 009 profile 图片存储语义变更: 两列存的东西从「完整绝对 URL」改成「OSS objectKey」,
-- 展示 URL 改由读侧 ossPublicBaseUrl() 现拼。
--
-- 动机不是洁癖 —— 存绝对 URL 会把「换展示域 / 换云账号」变成一次数据迁移,而这件事
-- 在本仓已经发生过两次: 2026-06 绑定备案域 img.shintongtech.com、2026-08 迁到账号 C。
-- 06-01 那份 runbook 当时就标了这是 design smell, 因「几乎无存量数据」而 defer;
-- 同一个理由第二次出现时,它就不再是可以 defer 的东西了。ideation 的两张表
-- (idea_attachment.oss_key / idea_mockup.object_key) 一开始就是这么存的,本次对齐。
--
-- 🚨 跳过 expand-migrate-contract 三步法 (.claude/rules/migration-rules.md §3):
--   条件 1 = M3 内测前, prod 无真实用户数据(仅维护者测试账号) —— 已确认;
--   条件 2 = PR 描述明示跳步理由 —— 见 PR body。
--   代价知情: prod 回滚是 image-only(不回退 schema), 故回滚窗口内旧镜像会 SELECT
--   到已不存在的 avatar_url 而使 GET /me 报错。在无真实用户的前提下接受。
--
-- 存量直接清空而非回填: 两列现有值全部指向账号 B 的桶 mbw-profile-images, 而该账号
-- 的 OSS 已欠费停服且不再续费, 对象整批弃用 ⇒ 那些是死 URL, 回填过去也只是死 key。

UPDATE "account"."account"
   SET "avatar_url" = NULL,
       "background_image_url" = NULL;

ALTER TABLE "account"."account" RENAME COLUMN "avatar_url" TO "avatar_object_key";
ALTER TABLE "account"."account" RENAME COLUMN "background_image_url" TO "background_object_key";
