-- 注: prisma migrate dev 误生成的 `DROP INDEX ix_instrument_pinyin_abbr_trgm` 已剔除 —
-- 该 GIN 三元组拼音索引由 raw SQL migration 建 (20260602_1430, prisma schema 表达不了),
-- prisma 不认识非要删它 (本 wrapper scripts/prisma-migrate.ts 自动剔除)。

-- 062 交易日历**覆盖声明** (spec FR-001 / FR-002 / FR-003, plan D1)。
-- expand-only: 单条 CREATE TABLE, 零破坏性变更 → 单 PR 合规
--   (ADR-0035 + .claude/rules/migration-rules.md § 2)。marketdata schema 已存在, 不新建。
--
-- 「该市场的日历已完备覆盖到哪一段」的**显式承诺**, 是三态判定里「未知」的唯一依据
--   (apps/server/src/marketdata/trading-day.rules.ts)。空表 = 全 unknown, 各消费方按 unknown
--   分派照常工作 ⇒ **上线首刻不停摆** (spec Edge Case「首次上线」)。
--
-- 🚨 **不是 calendar_sync_health 加两列**: 那张表答「填充还活着吗」(liveness), 本表答「视野
--   覆盖到哪儿了」(coverage)。044 已把 liveness 与 freshness 分清过一次; 混一张表 = 两个语义
--   重新焊死, 探针再也分不出「填充挂了」与「填充活着但视野不动」—— 而这两种故障的处置完全不同。
--
-- 🚫 **MUST NOT 有人后来把它改成从 max(trading_day.date) 派生** (FR-003): 最大值看不出区间
--   中间的空洞, 那是又一次「库里没有的即为假」推断 —— 正是本 feature 要根治的病。声明只由
--   填充路径在**整段成功后**写进来, 机器强制在 scripts/checks/check-trading-day-read.ts Check B。
--
-- 🚨 **填充失败的 catch 分支绝不碰本表**: 声明一旦在失败时照样前进, 三态判定全线失真, 而
--   测试通常只断言「成功时推进」⇒ 不会红。推进判据本身在 calendar-coverage.rules.ts (纯函数,
--   相邻/重叠才扩展, 有缺口不推进 ⇒ 声明区间内不产生空洞)。
--
-- 🚨 **索引只建 PK**: 三行 (cn/hk/us), 查询形状就是按 market 点查, 撒 B-tree 是 cargo cult
--   (判据同 anchor_cold_start_run 那份 migration)。
--
-- 本表已在 scripts/checks/check-server-moat.ts 的 MODEL_OWNERSHIP 登记为 'marketdata'
--   (漏登记 → moat-unmapped 硬拒)。
--
-- migration_refs: specs/062-trading-calendar-horizon (FR-001 / FR-002 / FR-003)

-- CreateTable
CREATE TABLE "marketdata"."calendar_coverage" (
    "market" VARCHAR(8) NOT NULL,
    "covered_from" DATE NOT NULL,
    "covered_to" DATE NOT NULL,
    "served_by" VARCHAR(16),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "calendar_coverage_pkey" PRIMARY KEY ("market")
);
