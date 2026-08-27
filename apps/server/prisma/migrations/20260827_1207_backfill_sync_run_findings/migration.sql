-- #209 三步法 **第 2 步 (migrate)**: 把历史行的 `failed_targets` 回填进 `findings`。
--
-- 第 1 步 (20260827_0927) 只加了列 + 应用双写 ⇒ **上线之前的行 `findings` 恒为 SQL NULL**。
-- 读侧本步改读 `findings`, 不回填就等于把上线前的全部审计明细一次性弄丢。
--
-- ## 🚨 `findings IS NULL` 在这里是**精确**的目标条件, 不是「大概齐」
--
-- 两种 NULL 在本列上都存在, 且语义不同:
--   · **SQL NULL**  = 这一行从没写过 `findings` ⇒ 只可能是第 1 步上线**之前**的行 ⇒ 要回填;
--   · **JSON `null`** (`Prisma.JsonNull`, 见 `sync-run.recorder.ts` 的 `payload`) = 这一轮**上报过**,
--     且确实没有任何 finding ⇒ **不该被当成待回填**。
-- `IS NULL` 只认前者 ⇒ 本语句天然幂等 (重跑第二遍零行受影响), 也不会拿旧列去盖新列已写下的空态。
--
-- 🚨 实测提醒 (2026-08-27 prod): 全表 802 行里 **749 行**的 `failed_targets` 存的是 **JSON `null`**
-- 而非 SQL NULL ⇒ 任何消费方写 `findings IS NOT NULL` 都会把这 749 行当成「有明细」。
-- 正确的谓词是 `jsonb_typeof(findings) = 'array'` —— 见 `ops/jobs/marketdata-sync-report.sql`。
--
-- ## 🚨 回填进来的 entry **没有 `kind`**
--
-- `kind` 是第 1 步才加的 ⇒ 历史 entry 形如 `{symbol, step, error}`, 无判别字段。
-- **MUST NOT 在这里替它们猜 `kind`** (按 step 反推 = 拿字符串匹配伪造一个本来不存在的事实,
-- 且猜错了不会有任何东西报错)。读侧的对偶约定: 无 `kind` 的 entry 归 `legacy` 桶照常展示,
-- 判据见 `marketdata-sync-report.sql`。
--
-- 本步 expand-only 语义: 不删列、不改列、不加约束 ⇒ 回滚到第 1 步的镜像仍双写两列, 而读侧
-- (ops/jobs 随部署铺到机器上, **不随镜像回滚**) 读 `findings` —— 读得到。
--
-- migration_refs: .claude/rules/migration-rules.md §2 (expand-migrate-contract 三步法)

UPDATE "marketdata"."sync_run"
   SET "findings" = "failed_targets"
 WHERE "findings" IS NULL;
