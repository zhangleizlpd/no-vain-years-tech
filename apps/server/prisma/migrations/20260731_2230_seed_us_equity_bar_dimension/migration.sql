-- sellput-viz: us 正股日线维度 `us_equity_bar` (p3b §4.4)。**纯 seed，无 DDL** —— us 日线写
-- 进既有 `marketdata.daily_bar`（该表 instrument_id + trade_date + adjust，market-agnostic），
-- 不新建表。
--
-- 🚨 为什么是**独立维度**而不是给 `eod_bar` 的 market_scope 加个 'us'（两条理由都是硬的）:
--   ① **调度时点不同**：美股 16:00 ET 收盘落在北京**次日凌晨** ⇒ us 只能排清晨，而一个维度
--      只有一个 `cron_expr`。合并 = 要么 us 晚一天、要么把 cn/hk 挪到凌晨。
--   ② **工作集陷阱**（p3b §3.3）：tick payload 无 `markets` 字段，`loadActiveInstruments`
--      的工作集恒为**全 market_scope**。把 us 掺进 cn/hk 维度，会在「只有 us 开市」的日子
--      （国庆/春节里的美股交易日）对**全部 cn+hk+us 标的**发请求 —— A 股休市日照烧一整轮配额。
--   ⚠️ p3b §4.4 原写的理由「eod_bar 的 port 实现是理杏仁、对 us 硬编码拒绝」**已失效**
--      （EOD_BAR_PORT 已改为按市场路由）。结论不变，但别再引用那条理由。
--
-- cron `0 0 6 * * *`（Asia/Shanghai）：北京 06:00 = 前一交易日 18:00 EDT / 17:00 EST，
-- 两者都在 16:00 收盘之后 ⇒ 固定 cron 全年成立，无需跟 DST 调。
-- ⚠️ 配套前提：tick 的 `asOf` 已改为**按市场时区**求值（`marketDateFor`）。若退回全局
-- `shanghaiToday`，本维度会日期错位一天且每周固定丢掉周五（该函数注释有失败形态表）。
--
-- `adjust_types = {none}`：与 `eod_bar` 一致。该列语义自 020 起 deprecated（恒 {none}）——
-- 复权由读侧按 AdjustmentFactor 计算，源侧只供**不复权原始价**。
--
-- `vendor = 'futu'` 仅记录建表意图；**代码从不读取该列**（见 schema 注释），运行时 vendor 由
-- EOD_BAR_PORT 的按市场路由决定。
--
-- `history_depth = 3650`：富途历史上限实测约为**滚动 10 年**（p3b E35 于 trading_days 实证；
-- kline 侧同界待 env-gated 真 IT 复核）。取 10 年即贴着上限，不做无意义的更深回填。
--
-- ⚠️ **上线即零数据是预期的**：全部 us 标的 `need_sync = false`（无锚不采，migration
-- 20260730_1600）。开闸靠锚驱动（045 US4）或过渡期人工 SQL，本 migration 不动闸。
--
-- migration_refs: docs/plans/2026-07/07-30-sellput-viz-p3b-data-architecture.md (§4.4 / §10)
INSERT INTO "marketdata"."sync_dimension"
  ("dimension_key", "enabled", "cron_expr", "vendor", "market_scope", "adjust_types",
   "batch_size", "history_depth", "priority", "freshness_profile", "sla_hours")
VALUES
  ('us_equity_bar', true, '0 0 6 * * *', 'futu', '{us}'::text[], '{none}'::text[],
   1, 3650, 5, 'continuous-daily', 26)
ON CONFLICT ("dimension_key") DO NOTHING;

-- universe → us_equity_bar 的 **soft** 边（同既有 5 维度先例）：标的须先注册，但 universe
-- 缺席/失败不该拖垮日线同步（universe→* 全 soft 是第一道拦截，017 先例）。
INSERT INTO "marketdata"."sync_dependency" ("upstream", "downstream", "mode")
VALUES ('universe', 'us_equity_bar', 'soft')
ON CONFLICT ("upstream", "downstream") DO NOTHING;
