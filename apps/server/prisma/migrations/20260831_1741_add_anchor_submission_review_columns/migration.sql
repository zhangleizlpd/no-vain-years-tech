-- 072: 待审箱审阅面扩容 —— 两列 + 存量去重 + (ticker,asof) partial unique。
--
-- 🚨 三步的**顺序不可调换**:先加 review_note(去重那步要写它) → 再去重(把每组重复里较晚的
--    一条标 REJECTED) → 最后建唯一索引。反过来 CREATE UNIQUE INDEX 会当场撞上存量重复而失败。

-- ── 1. 两列(expand-only,均 nullable) ────────────────────────────────────────
ALTER TABLE "optionsdesk"."anchor_submission"
  ADD COLUMN "review_note"        VARCHAR(512),
  ADD COLUMN "consumed_anchor_id" BIGINT;

-- ── 2. 存量去重 ─────────────────────────────────────────────────────────────
-- 08-31 直查 prod:PENDING 47 行,distinct (submitter,ticker,asof)=45 且 distinct 完整五元组
-- **也是 45**,「同 (ticker,asof) 但估值不同」的组数 = 0 ⇒ 每一组重复都是逐值全等的误投,
-- 折叠零信息损失(判据全文见 schema.prisma 该 model 头注释与 ADR-0069)。
--
-- 🚨 标 REJECTED 而**不是 DELETE**:删 prod 行不可逆,而这些行虽无信息增量却是真实发生过的
--    投递。标记非破坏、可审计、可回滚。每组保留 MIN(id)(最早那次投递)。
-- ⚠️ 幂等:WHERE status='PENDING' 使本语句重跑无副作用(已被标掉的行不再入选)。
WITH dupes AS (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY ticker, asof ORDER BY id) AS rn,
         MIN(id)      OVER (PARTITION BY ticker, asof)             AS keep_id
  FROM "optionsdesk"."anchor_submission"
  WHERE status = 'PENDING'
)
UPDATE "optionsdesk"."anchor_submission" s
SET status      = 'REJECTED',
    review_note = '重复提交,与 #' || d.keep_id || ' 逐值一致(072 去重)',
    updated_at  = now()
FROM dupes d
WHERE s.id = d.id AND d.rn > 1;

-- ── 3. partial unique ───────────────────────────────────────────────────────
-- 语义:同一个 (标的, 口径日) **同时**最多一条待审。
-- 🚨 必须 partial:全表唯一会让「驳回后重投一份修正版」永久不可能,而那恰是驳回之后最该发生的事。
-- ⚠️ Prisma 把它建模成全表复合唯一(谓词在类型系统里消失)⇒ 应用侧读写必须自己写出
--    status='PENDING' 条件,且禁用 upsert(PG 对部分索引要求 ON CONFLICT 带同样谓词)。
CREATE UNIQUE INDEX "uk_anchor_submission_pending_ticker_asof"
  ON "optionsdesk"."anchor_submission" ("ticker", "asof")
  WHERE status = 'PENDING';
