-- #172 / ADR-0067: 把已入库的**带内哨兵**回改成 NULL —— `(price, size)` 成对为 0 = 该侧无挂单。
-- **纯 UPDATE, 无 DDL, 无新行。**
--
-- ══ 为什么这是修数据而不是改口径 ═══════════════════════════════════════════════════════
-- 富途不用 null 表达「没有」, 它用带内哨兵 `0`。adapter 的 `numToString` 只认带外缺失
-- (不下发 / 非有限数 / 空串) ⇒ 那道闸在这个 vendor 上恒不触发, 哨兵原样落进 bid / ask 列,
-- 变成**看起来有效的报价**。修法已随同一 feature 落在采集端 (vendor-absence.rules.ts),
-- 本条清理的是修法生效**之前**已经写进库的那批。
--
-- ⚠️ 判据必须**成对**, MUST NOT 只看价格: OPRA Binary Participant Interface 明写
-- 「Zero in the bid price field represents a valid Bid Price」⇒ 零价可以是合法报价。
-- `WHERE price = 0 AND size = 0` 与采集端 `normalizeQuoteSide` 的判据**逐字同构** ——
-- 两处若分叉, 表现是「历史行与新行语义不一致」且不报错。
--
-- ══ 混合形态刻意不动 ═══════════════════════════════════════════════════════════════════
-- `(0, vol>0)` / `(price>0, 0)` 这类形态**一行都不碰**: 它们是「哨兵理论破裂」的证据,
-- 归一掉等于把警报器拆了 (ADR-0067 §D4)。2026-08-24 prod 实测这类形态为 0 行, 但 WHERE
-- 条件仍按成对写 —— 让「将来出现了」这件事保持可见。
--
-- ══ 这是行为变更, 不是纯清洗 ═══════════════════════════════════════════════════════════
-- 下游 optionsdesk 早已按 `bid: Decimal | null` 写好 (leg-derive.rules.ts:「无 bid → null,
-- 🚫 MUST NOT 当 0 (那是「白送」的意思)」), 但那片分支从未执行过 —— 上游保证了 bid 永不为 null。
-- 回改后:
--   · `computeEffectiveCost(K, 0) = K` 这个**看起来有效**的「有效成本」→ 变成 null (正确)
--   · `passesPremiumMin`: 0 与 null 都不过闸, 结果不变
-- ⇒ UI 上「有效成本」列会有可见变化, 方向是把假数字换成「不可算」。
--
-- ⚠️ 幂等: 重跑为零行更新。
-- ⚠️ 不可逆: 回改后无法区分「原本是哨兵 0」与「本来就是 NULL」。但哨兵 0 不承载信息,
--    且 `_prisma_migrations` 留有执行记录, 判据可从本文件复原。
--
-- 影响面 (2026-08-24 prod 实测): bid 侧 37,340 行 (us 36,979 + hk 361);
--                                ask 侧  1,626 行 (us  1,374 + hk 252)。
--
-- migration_refs: #172 (ask=0 被当真报价) / ADR-0067 (vendor 缺失语义)

UPDATE "marketdata"."option_daily_snapshot"
SET "bid" = NULL, "bid_size" = NULL
WHERE "bid" = 0 AND "bid_size" = 0;

UPDATE "marketdata"."option_daily_snapshot"
SET "ask" = NULL, "ask_size" = NULL
WHERE "ask" = 0 AND "ask_size" = 0;
