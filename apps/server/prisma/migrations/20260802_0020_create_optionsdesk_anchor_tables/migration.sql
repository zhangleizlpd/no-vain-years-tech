-- 045 optionsdesk 第 10 bounded context (ADR-0062) 首建: schema `optionsdesk` + 2 表。
-- expand-only: 仅 CREATE SCHEMA / CREATE TABLE / CREATE INDEX, 零破坏性变更 → 单 PR 合规
--   (ADR-0035 + .claude/rules/migration-rules.md §2)。datasource schemas 数组同 PR 由 7 项
--   加到 8 项 (加 "optionsdesk"), 故此处需 CREATE SCHEMA (与 marketdata/alert 等既有 schema 不同,
--   那些在各自首建 migration 已立)。
--
-- anchor (锚主表) = 「我给这只票估过值」的自有事实。落库边界按 FR-003a 判定, 判据是
--   「**是否参与 SQL 筛选/排序**」与「**是否带人工状态**」, **不是**变更频次 (plan D2):
--   W = 0.8V / 四区间边界 / 愿卖锚两档 / 距 W% 一律**不落库**, 请求时由 anchor.rules.ts 算
--   (口径仍在演进, 物化必 drift); 档位常量落 rules 文件顶部具名常量, **不建配置表** (FR-030)。
--   l_level_effective 是唯一物化的派生值 —— 它是雷达筛选主维度 (FR-034) 必须能被 WHERE 直接
--   过滤, 但**故意不用 DB 生成列**: 映射算法后续会演进, 生成列改算法要 DDL 变更 (FR-033/plan D3)。
--   ticker (canonical `market:code`) 全局唯一 = FR-001「同一 ticker MUST NOT 存在两条有效锚」;
--   单人自用故**无 account_id 列** (加了会与全局唯一约束打架)。
--   last_close / last_close_date 是 marketdata.daily_bar 的**单向投影**不是事实 (FR-036):
--   落本表的唯一理由 = 让距 W% 成为**同表**表达式从而 SQL 可排序 (跨表 join 排序 = 把护城河
--   边界拖进查询计划); 读端 MUST NOT 反写 daily_bar。
--   索引只建 ticker 唯一约束 —— 雷达 ORDER BY 是**表达式**距 W%, 普通 B-tree 帮不上排序,
--   而锚表规模上限约 1000 行 (spec Assumptions) ⇒ L 层 / next_review 过滤索引在 seq scan + sort
--   面前是净噪声; 将来提速的正确姿势是表达式索引 (plan D8)。
--
-- anchor_change (变更痕迹表) = **一行一次变更**非一行一字段 (FR-031 原文「本次变更的字段集」),
--   支撑 PIT 还原任一历史时点的 V / W / L 层 / 单票上限 / 愿卖锚。
--   🚨 anchor_id 是**逻辑引用、无 FK 约束** —— 删锚**不级联删**痕迹 (删锚本身也是一条痕迹行,
--   FR-031)。理由是不可逆性: P5 接货池「建仓折扣效率」比的是开仓当时的 W, 本片不留则 M4 永远
--   补不回来。同 AgentQueueEvent / IdeationMockup 体例, 关系完整性由 UC 保证。
--
-- DDL 由 `prisma migrate diff --from-config-datasource --to-schema` 从 schema.prisma 生成 (零 drift),
--   剔除 diff 误报的 `DROP INDEX ix_instrument_pinyin_abbr_trgm` (pg_trgm GIN 索引 schema.prisma
--   无法建模, 属既有 committed 索引 20260602_1430, 本 migration 不触 — 同 043/044 先例)。
-- migration_refs: specs/045-optionsdesk-anchors-radar (FR-001 ticker 唯一 / FR-003a 物化分档 /
--   FR-031 痕迹不级联删 / FR-033 生效 L 层普通列 / FR-036 last_close 单向投影)。

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "optionsdesk";

-- CreateTable
CREATE TABLE "optionsdesk"."anchor" (
    "id" BIGSERIAL NOT NULL,
    "ticker" VARCHAR(32) NOT NULL,
    "v" DECIMAL(18,4) NOT NULL,
    "asof" DATE NOT NULL,
    "method" VARCHAR(32) NOT NULL,
    "confidence" DECIMAL(4,2) NOT NULL,
    "confidence_source" VARCHAR(8) NOT NULL,
    "excluded" BOOLEAN NOT NULL DEFAULT false,
    "exclude_reason" VARCHAR(128),
    "next_review" DATE,
    "last_reviewed_on" DATE,
    "v_manual" DECIMAL(18,4),
    "l_level_manual" VARCHAR(2),
    "position_cap_manual" DECIMAL(6,4),
    "l_level_effective" VARCHAR(2) NOT NULL,
    "last_close" DECIMAL(18,4),
    "last_close_date" DATE,
    "breach_started_on" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "anchor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "optionsdesk"."anchor_change" (
    "id" BIGSERIAL NOT NULL,
    "anchor_id" BIGINT NOT NULL,
    "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changed_fields" TEXT[],
    "before_values" JSONB NOT NULL,
    "source" VARCHAR(8) NOT NULL,

    CONSTRAINT "anchor_change_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uk_anchor_ticker" ON "optionsdesk"."anchor"("ticker");

-- CreateIndex
CREATE INDEX "ix_anchor_change_anchor_changed_at" ON "optionsdesk"."anchor_change"("anchor_id", "changed_at" DESC);
