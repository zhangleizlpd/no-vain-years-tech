-- 061 marketdata 实时面: optionsdesk.anchor 加**盘中实时价两列** (FR-013 / FR-015 / FR-019,
-- plan D3)。两列均 nullable、无默认值、无约束变更 ⇒ expand-only, 零破坏性变更, **不触发**
-- expand-migrate-contract 三步法 (那是破坏性变更才要走的)。既有行落 NULL, 语义 = 「还没经历
-- 过任何盘中采集」。
--
-- 🚨 `intraday_at` 是**我们的采集墙钟**, 不是 vendor 的时间戳。vendor 那个是「最后成交时刻」,
--   实测盘中滞后中位 40 s / p95 292 s / max 672 s —— 拿它判新鲜度会在正常交易时段内把活跃标的
--   稳定误判成陈旧 (FR-006)。
-- 🚨 因此它是 `TIMESTAMPTZ(6)` 而**不是** `DATE`: 日期列会把「什么时候采的」压平成「哪天采的」,
--   90 秒的新鲜度闸当场恒为真, 陈旧价被一路当实时价用 —— 而排序、类型、测试**没有一处会红**。
--
-- ⚠️ 这两列**同 `last_close` 一样不入 `anchor_change` 痕迹表**: 痕迹记的是「锚事实被谁改成
--   什么」(FR-031 的 PIT 还原对象), 行情投影是外部数据的单向镜像、不是人或模型对锚的判断 ——
--   每 30 秒一条灌进去会把 PIT 回放整个淹没在行情噪声里 (`sync-anchor-quote.ts` 已为
--   `last_close` 立此规矩, 本片同理)。
--
-- ⚠️ `last_close` / `last_close_date` **语义一字不变** (FR-015): 它仍是当日收盘的权威值 (含
--   拆股/分红调整与错单撤销后的修订值), 也仍是一切降级路径的**唯一落脚点**。盘中两列是与它
--   **并列的第二个价源, 不是替代** —— 任何降级路径 MUST NOT 清空盘中两列, 也 MUST NOT 让
--   盘中价顶替收盘价的权威地位。
--
-- 🚫 这是「**最近一次**」不是历史序列 (FR-019): **MUST NOT** 有人后来为它加一张
--   `anchor_intraday_history`。盘中价的历史归 `marketdata.daily_bar`, 本表只留最新一拍。
--
-- migration_refs: specs/061-marketdata-realtime-spot (FR-013 / FR-015 / FR-019)

-- AlterTable
ALTER TABLE "optionsdesk"."anchor" ADD COLUMN     "intraday_at" TIMESTAMPTZ(6),
ADD COLUMN     "intraday_price" DECIMAL(18,4);
