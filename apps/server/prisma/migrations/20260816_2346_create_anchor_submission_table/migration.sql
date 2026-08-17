-- 注: prisma migrate dev 误生成的 `DROP INDEX ix_instrument_pinyin_abbr_trgm` 已剔除 —
-- 该 GIN 三元组拼音索引由 raw SQL migration 建 (20260602_1430, prisma schema 表达不了),
-- prisma 不认识非要删它 (本 wrapper scripts/prisma-migrate.ts 自动剔除)。

-- 059 锚的待审收件箱: 其他访客送进来的估值只落这里, 锚表零变化 (FR-011)。
-- expand-only: 仅 CREATE TABLE, 零破坏性变更 → 单 PR 合规
--   (ADR-0035 + .claude/rules/migration-rules.md §2)。optionsdesk schema 已存在, 不新建。
--
-- 一行 = 一次提交, **无唯一键**: 同一访客同一标的提交两次是两行 (归属与时序完整),
--   幂等在这里是错的语义 —— 采纳与否由人逐行判断。
--
-- 🚨 **索引只建 PK**。日均个位数条目, 在 status 上撒 B-tree 是 cargo cult: 全表扫十几行
--   比走索引还快, 而每条索引都要在写路径上维护。判据同 research_report migration 自己写的
--   那句「按真实查询形状建才对」—— 真到每天十几条要按标的/状态检索时再按那时的形状建。
--
-- 本表已在 scripts/checks/check-server-moat.ts 的 MODEL_OWNERSHIP 登记为 'optionsdesk'
--   (漏登记 → moat-unmapped 硬拒, 且报错指向探针不指向表)。

-- CreateTable
CREATE TABLE "optionsdesk"."anchor_submission" (
    "id" BIGSERIAL NOT NULL,
    "submitter" VARCHAR(64) NOT NULL,
    "ticker" VARCHAR(32) NOT NULL,
    "v" DECIMAL(18,4) NOT NULL,
    "asof" DATE NOT NULL,
    "method" VARCHAR(32) NOT NULL,
    "confidence" DECIMAL(4,2) NOT NULL,
    "note" VARCHAR(512),
    "status" VARCHAR(16) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "anchor_submission_pkey" PRIMARY KEY ("id")
);
