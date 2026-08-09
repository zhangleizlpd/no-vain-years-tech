-- 046 optionsdesk M2a 两个新采集维度 seed (p3b §4.4 表 + plan D1)。**纯 seed，无 DDL** ——
-- 表由前一条 migration 20260803_1210 建。样板 = 20260731_2230_seed_us_equity_bar_dimension。
--
-- cron `0 0 6 * * *`（Asia/Shanghai）与 `us_equity_bar` **同档**：北京 06:00 = 前一交易日
-- 18:00 EDT / 17:00 EST，两者都在 16:00 美股收盘之后 ⇒ 固定 cron 全年成立，无需跟 DST 调。
-- ⚠️ 配套前提同 us_equity_bar：tick 的 `asOf` 已按市场时区求值（`marketDateFor`，FR-028）。
-- 退回全局 `shanghaiToday` 会让两个维度日期错位一天且每周固定丢掉周五。
--
-- ── underlying_iv_daily（标的级 IV 日快照 + 历史序列增量）────────────────────────────────
-- `market_scope = {us}` 在这里**既是元数据也是工作集判据**：走 `factExecutor` 的
--   `loadActiveInstruments`（`market ∈ scope AND status='active' AND need_sync=true`）
--   ⇒ **无锚不采**（FR-026），加第 13 只锚零代码自动纳入（FR-031）。
--   否则工作集从 12 只炸到 19,465 只 us 标的（E37 prod 实测）。
-- `batch_size = 500`：`get_option_underlying_overview` 官方批量上限 = 500 codes（p3b E9），
--   限频 60 次/30s。⚠️ **别套 `/kline` 那个最严兜底值** —— 当初把 kline 挂全局最严限额且逐页
--   计数，直接导致 08-01 回填事故（p3b E38）。新端点一律按各自官方值配（plan D7）。
-- `history_depth = 1095`：`his_volatility` 实测可回看约 3 年（p3 07-29 实拉）。首次上线**拉满**
--   而非只拉 IVP 所需的 252 交易日下限（FR-024）—— 决定性理由是**不可逆性**：那 3 年是**滑动
--   窗**，今天不拉、明年再要中间那段就永久没了。成本可忽略（12 只 × 约 3 页 ≈ 36 次请求）。
-- `delta_lookback_days` 留 NULL：`overview` 是**快照端点**（问「现在」，不吃日期区间），
--   回看窗对它无意义；历史序列的尾部增量走 backfill 分页路径自己控窗（T009）。
--   ⇒ 与 20260802_1545 给区间型维度配回看窗的规则**不冲突**，是端点形态不同。
--
-- ── us_index_daily（VIX / VVIX 日线）────────────────────────────────────────────────────
-- 🚨 `market_scope = {us}` 在这里**只是元数据**（供 tick 的 per-market 交易日 gate 用），
--   **工作集不由它推导** —— 工作集 = VIX / VVIX 两个固定代码常量，**不查 `Instrument`、不挂
--   锚闸**（FR-027 / plan D1）。理由有二：① 富途与东财均不收录这两个代码（p3b E4/E26）⇒ 库里
--   根本不存在对应的 `Instrument` 行 ② 挂了闸**零锚时指数采集会静默不跑**，与 FR-018 空态分支
--   「指数表盘不依赖锚，零锚照常渲染」直接矛盾。⇒ 它的 executor **不复用 `factExecutor`**
--   （那条路径先 `loadActiveInstruments`），形态更接近既有 meta 维度。
-- `history_depth = NULL`：源是**覆盖式全量历史文件**（几百 KB，无增量端点）⇒ 取数形态 = 全量
--   文件 upsert，幂等天然成立，**没有「回填区间」这个概念**（同 hot_snapshot /
--   industry_classification 的覆盖式快照处理，不进 backfill 区间估算）。
-- `vendor = 'cboe'` 仅记录建表意图；**代码从不读取该列**（见 schema.prisma 该列注释）。
--
-- migration_refs: specs/046-optionsdesk-detail-thermometer (FR-023 标的级 IV 采集 / FR-024 拉满
--   3 年 / FR-025 指数采集 / FR-026 标的级挂锚闸 / FR-027 指数级不挂锚闸 / FR-028 A′ us 时区)

INSERT INTO "marketdata"."sync_dimension"
  ("dimension_key", "enabled", "cron_expr", "vendor", "market_scope", "adjust_types",
   "batch_size", "history_depth", "priority", "freshness_profile", "sla_hours")
VALUES
  ('underlying_iv_daily', true, '0 0 6 * * *', 'futu', '{us}'::text[], '{none}'::text[],
   500, 1095, 5, 'continuous-daily', 26),
  ('us_index_daily', true, '0 0 6 * * *', 'cboe', '{us}'::text[], '{none}'::text[],
   1, NULL, 5, 'continuous-daily', 26)
ON CONFLICT ("dimension_key") DO NOTHING;

-- universe → underlying_iv_daily 的 **soft** 边（同 us_equity_bar 先例）：标的须先注册才有
-- instrument_id 可挂，但 universe 缺席/失败不该拖垮 IV 同步（universe→* 全 soft 是第一道拦截）。
--
-- 🚨 **us_index_daily 刻意没有这条边** —— 它不读 `Instrument`，与 universe 无任何数据依赖。
-- 给它连一条 universe 边不是「保险起见」，而是把「指数不依赖锚/不依赖标的注册」这个决策
-- （FR-027）在依赖图上写反。无入边 ⇒ Kahn 拓扑里它是根，照常调度。
INSERT INTO "marketdata"."sync_dependency" ("upstream", "downstream", "mode")
VALUES ('universe', 'underlying_iv_daily', 'soft')
ON CONFLICT ("upstream", "downstream") DO NOTHING;
