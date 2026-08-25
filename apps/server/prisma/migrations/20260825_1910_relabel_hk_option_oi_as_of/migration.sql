-- 066 T09 / FR-016: 把已入库的**港股**期权快照的 `oi_as_of` 重标成 `session_date`。
-- **纯 UPDATE, 无 DDL, 无新行。**
--
-- ══ 为什么这是修数据而不是改口径 ═══════════════════════════════════════════════════════
-- 「T 日的未平仓合约数要 T+1 才发布」是**美股清算所的**行为, 而归属规则此前是**市场无关**的
-- (`resolveSnapshotAttribution` / `resolveSnapshotSpec` 的 `oiRefreshed` 只看「跨没跨进下一场
-- 的盘前」) ⇒ 港股走收盘当晚那条 `eod` 路径时, `oi_as_of` 被系统性地退了一天。
--
-- 2026-08-25 U2 实测推翻了那个类推: 30 只腾讯期权 12 拍 360 行样本里, 未平仓合约数在整个
-- 窗口**只变动过一次** —— 2026-08-24(一) 16:30 → 21:30, 24/30 只变; 跨 22:00 日终那一拍
-- **0/30**, 次日盘前 **0/30**, 周二同点位复现。⇒ 港股当日的 OI 在 **D 日收盘当晚**就已定稿
-- (窗口: 16:30 之后、21:30 之前), 而 `hk_option_daily_snapshot` 跑在 23:30, **落在定稿之后**
-- ⇒ 当晚抓到的就是 D 自己的 OI。修法已随同一 feature 落在判据层 (`oiRefreshedAtEod` 登记表 +
-- 三处消费方), 本条清理的是修法生效**之前**已经写进库的那批。
-- 结论原文见 `specs/066-hk-option-cold-start/spec.md` 的 `## Clarifications` 2026-08-25 段。
--
-- ══ 判据为什么不看 `source` ═══════════════════════════════════════════════════════════
-- 分叉之后, hk 的**两条路径**都取 `target`:
--   · `premarket_backfill` —— 跨进了下一场的盘前, OI 早已翻新 (改动前就是 `session_date`)
--   · `eod`                —— 该市场收盘当晚即定稿 (本条要修的就是它)
-- ⇒ hk 的不变式是 `oi_as_of ≡ session_date`, **与 `source` 无关**。按不变式写而不是按
-- `source = 'eod'` 写, 是为了让「将来又冒出第三条路径」时这条清理仍然成立。
--
-- 🚨 `market = 'hk'` 这个字面量与 `market-session.rules.ts` 的 `MARKET_OI_REFRESHED_AT_EOD`
--    是**同一个判断的两处表达**, SQL 里调不到那张表。两处若分叉, 表现是「历史行与新行语义
--    不一致」且**不报错** —— 将来给别的市场把那张表改成 `true` 时, MUST 同时补一条同形的
--    清理 migration。
--
-- ══ 为什么不是「等采集重跑一遍」═══════════════════════════════════════════════════════
-- 供应方不提供历史快照 ⇒ 那些行买不回来。而 `oi_as_of` 是**独立列**、不进
-- `(contract_id, session_date, source)` 唯一键、与未平仓合约数的**值**无关 ⇒ 重标是一条
-- 确定性 `UPDATE`, 不需重采 (FR-016 的不对称性判据)。
--
-- ⚠️ 幂等: 重跑为零行更新 (`WHERE oi_as_of <> session_date`)。
-- ⚠️ 不可逆: 重标后无法从库里区分「原本标错」与「本来就对」。但判据可从本文件复原,
--    且 `_prisma_migrations` 留有执行记录。
--
-- 影响面: 撰写时 (2026-08-25 19:10) prod 实测 **523 行** (`session_date = 2026-08-21`,
--         `oi_as_of = 2026-08-20`)。⚠️ **部署时会更多** —— 修法上线前每个交易日 23:30 那轮
--         都会再写一批带旧标签的行 (每轮约 2,200 行)。本条按不变式写, 届时一并扫掉。
--
-- migration_refs: 066 T09 / FR-016 (oiAsOf 按市场分叉) / #164 (U2 实测结论)

UPDATE "marketdata"."option_daily_snapshot" AS s
SET "oi_as_of" = s."session_date"
FROM "marketdata"."option_contract" AS c
WHERE c."id" = s."contract_id"
  AND c."market" = 'hk'
  AND s."oi_as_of" <> s."session_date";
