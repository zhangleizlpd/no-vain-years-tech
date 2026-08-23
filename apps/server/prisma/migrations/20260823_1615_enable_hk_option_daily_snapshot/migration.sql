-- 066 T06 开通港股冷启动的**第二个开关**: 把 hk_option_daily_snapshot 的启用位从 T04 seed 的
-- false 翻成 true (FR-010, FR-016, FR-016a, plan §A2)。**纯 update, 无 DDL, 无新行**。
--
-- ══ 为什么这条 SQL 必须与 `COLD_START_CAPABILITY.hk` 在同一个 commit 里 ══════════════════
-- 两者是**彼此独立的两条路**, 不是同一个开关的两处副本:
--   · `COLD_START_CAPABILITY.hk` (anchor-cold-start.rules.ts) 管**建锚路径** —— 冷启动**直调**
--     采集本体 (SyncOptionSnapshotUseCase.collect), 全程**不读** sync_dimension 的启用位
--     (全仓实证: 冷启动编排对 sync_dimension 零引用);
--   · 本行的 `enabled` 管**夜间 cron 路径** —— tick driver 只挑 enabled = true 的维度派 job。
-- ⇒ 只翻其一, 两条路当场分叉: 只翻能力表 = 新锚补得到、当晚 cron 一行都不采 (次日起每天缺一场,
--   而期权 EOD **无跨日补救**, 漏采即永久缺口); 只翻本行 = cron 采得到、新建的港股锚是空的。
--   **两种分叉都不报错**, 只是某一条路默默什么都没做。机械断言 (两者同真同假) 在
--   test/integration/marketdata-066.hk-dimension-seed.it.spec.ts。
--
-- ══ T04 当初为什么 seed 成 false, 现在为什么可以翻 ══════════════════════════════════════
-- T04 的理由是「HKEX 的 OI 归属日 (oi_as_of) 实测未出结论, 提前翻会让持仓量整体偏一天且不报错」。
-- 2026-08-23 **解绑**: `oi_as_of` 是快照行上的一个**独立日期列** —— 不进唯一键、与
-- net_open_interest 的**值**无关 ⇒ 标错了是一条**确定性 UPDATE** 的事 (依 source 与 session_date
-- 可判定, 066 FR-016); 而不采 = **永久缺口** (vendor 不提供历史交易日的期权快照)。同一条不对称性,
-- sync-option-snapshot.usecase.ts 对「日历缺行」那条路径早就选了「落库继续、抬 ERROR」——
-- 本次照它办。⇒ 港股快照**按现行 (美股) 规则先采**, U2 结论落地后由 T09 重标已采的行。
-- 🚫 **MUST NOT 在本次为港股的 oi_as_of 发明市场分叉** —— 那是 T09 的范围。
--
-- ══ 为什么是 UPDATE 而不是重写 T04 那份 migration ═══════════════════════════════════════
-- T04 的 migration 已经跑过 (checksum 入 _prisma_migrations)。改历史文件 = drift, migrate deploy
-- 在已部署库上直接拒。⇒ 状态迁移只能靠新增一条前向 migration (ADR-0035)。
--
-- ⚠️ 幂等: `WHERE enabled IS DISTINCT FROM true` 让重跑成为零行更新; 该行若已被人工翻开
-- (不该有人手翻, 但库是活的) 本条也不会白写一次。dimension_key 是唯一键, 不存在多行。
--
-- migration_refs: specs/066-hk-option-cold-start (FR-010 港股锚不再落 market_not_enabled /
--   FR-016 港股快照按现行规则先采 / FR-016a 两个开关必须同真同假)

UPDATE "marketdata"."sync_dimension"
SET "enabled" = true
WHERE "dimension_key" = 'hk_option_daily_snapshot'
  AND "enabled" IS DISTINCT FROM true;
