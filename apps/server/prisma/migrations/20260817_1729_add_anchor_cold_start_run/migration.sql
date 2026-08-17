-- 注: prisma migrate dev 误生成的 `DROP INDEX ix_instrument_pinyin_abbr_trgm` 已剔除 —
-- 该 GIN 三元组拼音索引由 raw SQL migration 建 (20260602_1430, prisma schema 表达不了),
-- prisma 不认识非要删它 (本 wrapper scripts/prisma-migrate.ts 自动剔除)。

-- 060 锚首建冷启动的运行记录 (spec FR-026 / FR-026a / FR-027 / FR-028, plan D7)。
-- expand-only: 单条 CREATE TABLE, 零破坏性变更 → 单 PR 合规
--   (ADR-0035 + .claude/rules/migration-rules.md §2)。marketdata schema 已存在, 不新建。
--
-- 🚨 **这张表不是待办队列**: 没有任何代码读它来决定「要不要重做」—— 起手复判查的是
--   option_daily_snapshot / daily_bar **本身** (FR-016a)。把它当判据就等于建了第二套补偿
--   机制; 且锚一旦按用户区分, 同标的的 N 只锚会各判「没做过」⇒ 同一份**标的级共享数据**
--   被拉 N 遍。盘中未做的部分仍由当晚常规轮补齐 (FR-013)。
--
-- 🚨 **PK = anchor_id 不是 ticker** (plan D5 幂等键表)。anchor.ticker 今天 @unique, 但同上:
--   按用户区分之后两只锚会撞同一行互相覆盖结局 (先建的「已补齐」被后建的「已具备零外呼」
--   盖掉)。今天两种写法完全等价、零额外成本 ⇒ 现在就按正确的写。ticker 作普通列留着,
--   纯为排障可读。IT 里有一条「删锚后同 ticker 重建 ⇒ 两行」把它钉住。
--
-- anchor_id **逻辑引用不建 FK** (跨 schema, 体例同 optionsdesk.anchor_change): 删锚不级联,
--   删后重建得到新 id ⇒ 新行, 语义正确。
--
-- outcome 八种取值 (FR-027) 是贫血字符串**无枚举表** (同 anchor_submission.status 三态体例);
--   值域权威在 apps/server/src/marketdata/anchor-cold-start.rules.ts 的 COLD_START_OUTCOME。
--
-- 🚨 **索引只建 PK**: 日均个位数条目, 查询形状就是按 anchor_id 点查, 撒 B-tree 是 cargo
--   cult (判据同 anchor_submission / research_report 那两份 migration 自己写的那句)。
--
-- 不复用 sync_run: 塞非维度行会污染 report.sh 逐维度解析 + 全景 IT 维度计数断言, 与 044 的
--   calendar_sync_health 做的是同一个判断。本表已在 scripts/checks/check-server-moat.ts 的
--   MODEL_OWNERSHIP 登记为 'marketdata' (漏登记 → moat-unmapped 硬拒)。

-- CreateTable
CREATE TABLE "marketdata"."anchor_cold_start_run" (
    "anchor_id" BIGINT NOT NULL,
    "ticker" VARCHAR(32) NOT NULL,
    "last_run_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "outcome" VARCHAR(32) NOT NULL,
    "reason" TEXT,
    "target_session" DATE,

    CONSTRAINT "anchor_cold_start_run_pkey" PRIMARY KEY ("anchor_id")
);
