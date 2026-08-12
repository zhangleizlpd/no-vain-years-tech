-- B 股计价币种订正: cn 市场的 B 股不是 CNY (纯数据 UPDATE, 无 DDL / 无破坏性变更 ⇒ 单 PR 合规
-- per .claude/rules/migration-rules.md §2)。
--
-- 沪深两市的 B 股虽挂在 `market = 'cn'`, 却以**外币交易** —— 深市 200xxx 港币 / 沪市 900xxx 美元,
-- 而 `DailyBar` 里存的价格就是那个本币。但 `currencyForMarket()` 原先只按 market 推币种
-- (cn → CNY 一刀切), 于是全部 78 只 B 股 (深市 37 + 沪市 41) 的 `currency` 都是错的。
--
-- 判据不是推测, 是价位本身自证 (2026-08-10 prod 收盘):
--   900902 市北B股 = 0.163 · 900903 大众B股 = 0.185 · 900906 中毅达B = 0.218
-- 沪市任何股票都不可能以 ¥0.16 交易 (低于 ¥1 即触及退市) ⇒ 这些数字只能是 USD。
--
-- 🚨 **标错不报错, 只让复权因子静默失真** —— 这才是它值得一条 migration 的原因:
--   派息 payload 的币种 (HKD/USD, 是**对的**) 与 `Instrument.currency` (CNY, 错的) 不符
--   → `buildFactorEventTerms` 的币种守卫把派息置 null (刻意不做汇率换算, 见该函数注释)
--   → 条款法退化成「无此事件」f = 1, 与见证法必然分歧 (实测相对误差 6.9% > 5% 容差)
--   → 该除权日落 `status = 'needs_review'` + `factor_backward = 1`
--   ⇒ **那只票除权日之前的整段历史都没被复权**。
--   2026-08-12 取证: 180 条 needs_review 里, cn 侧 13 条全部是 B 股, 且 13/13 都伴随一条
--   非 CNY 派息 —— 命中率 100%, 且每逢 B 股派息就新增一条 (这是当时唯一在持续增长的桶)。
--
-- 为什么**必须**有这条 migration, 光改 `currencyForMarket()` 不够:
--   `SyncUniverseUseCase` 的 upsert **update 分支刻意不写 currency** (FR-S03 护下游富化缓存),
--   ⇒ 代码修好后, 存量这 78 行**永远不会自愈**, 只有新入库的标的才走到新逻辑。
--
-- ⚠️ 跑完本 migration 后需**重锚因子**才能让存量那 13 条转正:
--     node dist/marketdata/marketdata-backfill.cli.js --factors   (零 vendor 外呼, 纯本地重算)
--   不重锚的话, 库里那些 factor_backward = 1 的行会一直留着 —— migration 只修输入, 不动产物。
--
-- 幂等: 带 `currency <> 目标值` 谓词, 重跑零变更。非 B 股 (000/001/002/003/300/301/60x/688/8x/92x)
-- 逐行零影响。

UPDATE "marketdata"."instrument" SET "currency" = 'HKD'
 WHERE "market" = 'cn' AND "code" LIKE '200%' AND "currency" <> 'HKD';

UPDATE "marketdata"."instrument" SET "currency" = 'USD'
 WHERE "market" = 'cn' AND "code" LIKE '900%' AND "currency" <> 'USD';
