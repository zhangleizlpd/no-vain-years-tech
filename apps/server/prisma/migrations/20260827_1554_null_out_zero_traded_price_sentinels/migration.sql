-- #258 / ADR-0067: 把已入库的**成交价类带内哨兵**回改成 NULL —— `last` / `prev_close` 的 `0`
-- 不是价格, 是「没有这个价」。**纯 UPDATE, 无 DDL, 无新行。**
--
-- ══ 为什么现在能改, 而 #172 那次只改了 bid/ask ═════════════════════════════════════════
-- ADR-0067 D3 把这两列登记为**待查**: 「0 值计数完全相等 (3312/3312), 疑似『从未成交』但
-- **不能凭数据断言**语义 —— 维持原样, 向 vendor 求证后再定」。
--
-- 求证回来了。富途官方 (py-futu-api#258, 2026-08-27, `hughex`) 书面答复:
--   · SDK 侧 `last_price = record.basic.curPrice` / `prev_close_price = record.basic.lastClosePrice`
--     **直接透传**, 无空值转换;
--   · OpenD 侧 `QotRealTimeData.cpp` 新建缓存条目时默认 `set_curprice(0) / set_lastcloseprice(0)`,
--     **`0` 就是「无价格数据」的占位**;
--   · **「期权成交价恒为正值 (最小价位 > 0), 接口返回的 0 一律表示无最后成交价, 不存在
--     『真实成交价恰为 0』的情况」**。
-- ⇒ 判据出处从「从数据反推」升级为「vendor 书面契约」, 即 ADR-0067 D5 第 3 问要的最强那一档。
--
-- ══ 判据为什么可以只看单列 (与 bid/ask 那条**故意不同**, 别互相套用) ═══════════════════
--   · 盘口 `bid`/`ask`: OPRA 明写「Zero in the bid price field represents a **valid** Bid Price」
--     ⇒ 零价可能是真报价 ⇒ 判据必须 `(price, size)` 成对为 0。
--   · 成交价 `last`/`prev_close`: 官方明说恒为正 ⇒ 没有那条反向约束 ⇒ 单列 `= 0` 即可。
-- 采集端同口径的实现是 `vendor-absence.rules.ts` 的 `tradedPriceOrNull`, **两处必须同判**;
-- 分叉的表现是「历史行与新行语义不一致」且**不报错**。
--
-- ══ 两个形态刻意一并归一 (它们不是「哨兵理论破裂」) ═══════════════════════════════════
--   · `prev_close = 0 ∧ last > 0` (实测 81 行) —— 新挂牌合约**首日无前收盘**, 官方确认;
--   · `last = 0 ∧ volume > 0`     (实测  2 行, `HK.ALB260904P122000` / `…P124000`, 2026-08-24,
--     有 13.7 万港元成交额却无成交价) —— 官方确认为首日「价格字段尚未填充」, **仍是无值**。
-- ⚠️ 官方称「后续交易日价格即恢复正常」(其 08-27 复测得 6.74 / 8.37), 但**救不了已落的行**:
--    供应方不提供历史期权快照 ⇒ 库里那两行永远是 0。归一成 NULL 才是诚实的表示 —— 我们
--    确实不知道那天的成交价。
--
-- ══ 这是行为变更, 不是纯清洗 ═══════════════════════════════════════════════════════════
-- `underlying_spot` 取自**标的行的 `last`** (`sync-option-snapshot.usecase.ts` 的 `spotByCode`),
-- 而下游 `leg-retrieval.adapter.ts` 对 `spot === null` 有守卫 (走 FR-012「未就绪」)、对
-- `spot === 0` **没有** ⇒ 哨兵会一路算进 moneyness / 有效成本。本条连它一起归一, 让那条已经
-- 写好的守卫真正生效。
-- 📌 撰写时 prod 全量副本实测 `underlying_spot = 0` 为 **0 行** ⇒ 该语句当下是空跑, 写在这里
--    是为了让「哪天真出现」时不需要第二条迁移, 与采集端改动同步生效。
--
-- ⚠️ 幂等: 重跑为零行更新。
-- ⚠️ 不可逆: 回改后无法区分「原本是哨兵 0」与「本来就是 NULL」。但哨兵 0 不承载信息,
--    判据可从本文件复原, 且 `_prisma_migrations` 留有执行记录。
--
-- 影响面 (2026-08-27, prod 全量副本 456,940 行实测): `last = 0` **5,511 行** (us 5,400 + hk 111);
--                                                    `prev_close = 0` **5,592 行** (us 5,400 + hk 192)。
--
-- migration_refs: py-futu-api#258 (vendor 书面答复) / ADR-0067 (vendor 缺失语义) / #172 (bid/ask 先例)

UPDATE "marketdata"."option_daily_snapshot"
SET "last" = NULL
WHERE "last" = 0;

UPDATE "marketdata"."option_daily_snapshot"
SET "prev_close" = NULL
WHERE "prev_close" = 0;

UPDATE "marketdata"."option_daily_snapshot"
SET "underlying_spot" = NULL
WHERE "underlying_spot" = 0;
