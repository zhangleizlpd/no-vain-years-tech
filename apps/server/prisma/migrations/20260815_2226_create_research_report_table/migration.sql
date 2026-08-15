-- 注: prisma migrate dev 误生成的 `DROP INDEX ix_instrument_pinyin_abbr_trgm` 已剔除 —
-- 该 GIN 三元组拼音索引由 raw SQL migration 建 (20260602_1430, prisma schema 表达不了),
-- prisma 不认识非要删它 (本 wrapper scripts/prisma-migrate.ts 自动剔除)。

-- 057 研报库 guest 投递: 立第 11 个 bounded context research 的存储地基 (ADR-0065)。
-- expand-only: 仅 CREATE SCHEMA / CREATE TABLE / CREATE UNIQUE INDEX, 零破坏性变更
--   → 单 PR 合规 (ADR-0035 + .claude/rules/migration-rules.md §2)。
--
-- 一行 = 一次投递, 不是「一份研报」: 同一字节被两个投递方各投一次是两行 (US5 归属完整性),
--   但 object_key 由 content_hash 单独导出 (与投递方无关) ⇒ 对象只存一份。唯一约束
--   (uploader_kind, uploader_ref, content_hash) 正是这条语义的机器表达。
--
-- symbol 是归一后的 `market:code` **裸字符串, 无 FK** —— 不建到 marketdata.instrument
--   的外键、不做存在性校验 (校验会拒绝合法新标的, 且引入本片刻意避免的跨 ctx 依赖)。
--   ⇒ 本表已在 scripts/checks/check-server-moat.ts 的 MODEL_OWNERSHIP 登记为 'research'。
--
-- 只建那条唯一索引: 它的前缀 (uploader_kind, uploader_ref) 恰好也是配额 SUM 的过滤列,
--   幂等查与配额查共用同一棵树。**不预先给 symbol 撒 B-tree** —— 本片零读取面, 按标的
--   检索属 PRD §3.8 后续 feature, 那时按真实查询形状建才对。

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "research";

-- CreateTable
CREATE TABLE "research"."research_report" (
    "id" BIGSERIAL NOT NULL,
    "symbol" VARCHAR(32) NOT NULL,
    "report_date" DATE NOT NULL,
    "title" VARCHAR(256) NOT NULL,
    "source" VARCHAR(64) NOT NULL DEFAULT '自研',
    "version" INTEGER NOT NULL DEFAULT 1,
    "content_hash" VARCHAR(64) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "original_filename" VARCHAR(256) NOT NULL,
    "object_key" VARCHAR(256) NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "uploader_kind" VARCHAR(16) NOT NULL,
    "uploader_ref" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "research_report_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uk_research_report_uploader_content" ON "research"."research_report"("uploader_kind", "uploader_ref", "content_hash");
