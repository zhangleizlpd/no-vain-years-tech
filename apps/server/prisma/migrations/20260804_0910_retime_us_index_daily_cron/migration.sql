-- us_index_daily 采集时点从北京 06:00 后移到 10:00 —— 06:00 踩在 CBOE 发布之前。
-- 只改这一个维度；`underlying_iv_daily` 与 `us_equity_bar` 均**不动**（理由见下）。
--
-- ── 病灶形态（2026-08-04 首跑实测）──────────────────────────────────────────────────────
-- 08-04 06:00 首跑 `SyncRun` = **success**（scanned = ok = 14314，failed 0，无 failed_targets），
-- 但落库最新一行停在 **07-31**，而 08-03（周一）是美股交易日（`trading_day` 有该行）。
-- 即：run 绿、数据缺 —— 「成功地取到了一份旧文件」。**不是失败形态，探针与 report 都照不出**。
--
-- 同日北京 09:00（= 08-03 21:00 ET）从 77 直连复拉同两个 URL，08-03 的行**都在**
-- （`VIX_History.csv` → 08/03 close 15.86；`VVIX_History.csv` → 08/03 90.81）。
-- ⇒ CBOE 历史 CSV 的发布时刻落在 **(18:00, 21:00] ET** 这个区间内，而北京 06:00
--   = 18:00 EDT / 17:00 EST，**恒在发布之前**。
--
-- 源是覆盖式全量文件 ⇒ 次日重跑自愈，**不会永久缺行**；代价是 VIX/VVIX 恒滞后一个交易日，
-- 与同屏 `underlying_iv_daily`（T-0）的 asOf 不自洽 —— 温度计一屏两个口径。
--
-- ── 为什么是 10:00 而不是 09:00 ────────────────────────────────────────────────────────
-- 实测只拿到**一个**可用点（21:00 ET 有），发布的精确时刻**未知**，故按区间上界留余量：
--   北京 10:00 = 22:00 EDT / 21:00 EST —— 两个 DST 档都 ≥ 已实证的可用点。
--   北京 09:00 = 21:00 EDT / **20:00 EST** —— 冬令时会退回未知区间，不取。
-- 与 20260731_2230 / 20260803_1230 的「固定 cron 全年成立、无需跟 DST 调」同理，仍成立。
--
-- 业务日 A′ **不变**：北京 06:00 与 10:00 都映射到**前一个 ET 日历日**（`marketDateFor`，
--   FR-028），08-04 那刻 A′ 均为 08-03；per-market 交易日 gate 与周末行为亦零变化
--   （北京周一 06:00 / 10:00 同样落在 ET 周日 → 同样 gate 掉）。
--
-- ⚠️ `underlying_iv_daily` **保持 06:00**：它走富途 shim 的 `overview` 快照端点，08-04 06:00
--    首跑已实测拿到 08-03 全 12 票（iv / iv_rank / iv_percentile 均非空）—— 那条链路在
--    18:00 ET 就绪，没有等待的理由。⇒ 两个 046 维度**从此不再同档**，钉「同档」的断言须随之
--    拆开（本 PR 已改 `marketdata.schema-016.it.spec.ts` / `optionsdesk-046.schema.it.spec.ts`）。
--
-- `next_fire_at` 一并置 NULL：tick 驱动对 `enabled AND next_fire_at IS NULL` 做懒初始化，
--   从 `now` 按新 cron 重算（`sync-tick-driver.ts` (a) 分支）。不置 NULL 的话，库里那条既有的
--   2026-08-04 22:00Z 仍会先在 08-05 06:00 按**旧**时点打一次、之后才自愈 —— 白丢一天。
--
-- migration_refs: specs/046-optionsdesk-detail-thermometer (FR-025 指数采集 / FR-028 A′ us 时区)

UPDATE "marketdata"."sync_dimension"
SET "cron_expr" = '0 0 10 * * *',
    "next_fire_at" = NULL
WHERE "dimension_key" = 'us_index_daily';
