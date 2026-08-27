-- 期权链发现与快照合进**同一个 tick** + 港股那条边降 soft。纯 data-only UPDATE, 无 DDL,
-- 幂等 (同值覆盖零副作用) → 单 PR 合规。回滚 = 一条反向 UPDATE。
--
-- ══ 为什么: 那两条 hard 边从上线至今**一次都没装配过** ═══════════════════════════════════
-- `hk_option_contract → hk_option_daily_snapshot` 与 `option_contract → option_daily_snapshot`
-- 都是 hard 边, 语义是「链发现失败必须断下游, 不能让快照拿着空/陈旧的合约集照跑」。
--
-- 但 ADR-0049 §3: **依赖边只约束同一 tick 内共同触发的维度**。两端 cron 差 30 分钟
-- (23:00 vs 23:30 / 06:00 vs 06:30) ⇒ 落在**两个 tick、两棵 flow 树** ⇒ 组第二棵树时
-- `assertEdgesExpressible` 见到 `chainPos.get(upstream) === undefined` 就**整段跳过**,
-- `failParentOnFailure` 从未被装上。⇒ 那条语义一直是句**全绿的空话**。
--
-- 🚨 顺序保证今天靠的是**巧合**, 不是结构: cron 错峰 + 同队列 FIFO + concurrency=1。
--    美股实测链发现常跑 30~44 分钟 (#179 取证: 06:30:59 仍 running, 06:44:05 已完成),
--    早就跨过 06:30 了 —— 一直是 FIFO 在兜底, 而不是那 30 分钟。合进同一 tick 之后,
--    顺序由**链结构**保证, 不再依赖「30 分钟够不够」这个从来没成立过的猜测。
--
-- 📌 合并**不改变实际起跑时刻**: 快照仍排在链发现之后 (美股仍约 06:30-06:45)。
--    变的是**失败语义**与顺序的**载体**。
--
-- ══ 时刻下界仍满足 ══════════════════════════════════════════════════════════════════
-- 港股 OI 定稿 21:30 HKT (`MARKET_OI_SETTLE_LOCAL_MINUTE.hk`) < 23:00 ✓
-- 美股收盘 04:00/05:00 北京 < 06:00 ✓ (`isCloseWriteBlocked` 的盘中闸落在真正要写的那一刻)
-- 相邻性无需动 `priority`: 两对同为 5, 同优先级下字典序
--   'option_contract' < 'option_daily_snapshot'、'hk_option_contract' < 'hk_option_daily_snapshot'
--   天然相邻 (守卫在 dimension-executor.spec.ts)。
--
-- ══ 🚨 为什么港股降 soft 而美股保 hard —— 判据是「能不能补救」, 不是对称美感 ═════════════
-- 美股有两级补救 (`OptionSnapshotRemediation`: 08:00 当日重试 + 18:00 盘前兜底) ⇒
--   fail-closed 了还救得回来 ⇒ 保 `hard`, 兑现原 migration 的本意。
-- 港股**零补救**: `US_MARKET_SCOPE = ['us']`, 无港股对应物; 且 `history_depth = NULL` ——
--   vendor 不提供历史交易日的期权快照, **漏采即永久缺口**。
--   ⇒ 对港股, fail-closed 会把「漏几张当天新挂牌的合约」换成「**整晚全丢且不可回补**」。
--
-- ⚠️ 存在一条**链发现专有**的硬失败路径, 这正是港股要挡的那一侧: `gapCheckExpiryDates`
--    对账 diff 非空**直接 throw** (sync-option-contract.usecase.ts)。走这条时 futu 是好的、
--    快照本来完全采得到 —— 拿它去断下游, 赔的是不可回补的那一晚。
--    (若两者同为 vendor 整体故障, 快照本来也采不到, hard 与 soft 无差别。)
--
-- 📌 **顺序保证与 mode 无关**: `ignoreDependencyOnFailure` 的 parent 同样要等 child 跑完才动,
--    只是不跟着失败。降 soft **不会**让快照跑到链发现前面去。
--
-- 🚫 **别"为了对称"把港股改回 hard** —— 那不是洁癖问题, 是拿永久缺口换一致性。要改先确认
--    港股已经有了自己的补救链 (受限于 vendor 不提供历史期权快照, 大概率做不了)。
--
-- migration_refs: issue #210
UPDATE "marketdata"."sync_dimension"
   SET "cron_expr" = '0 0 23 * * *', "updated_at" = now()
 WHERE "dimension_key" = 'hk_option_daily_snapshot';

UPDATE "marketdata"."sync_dimension"
   SET "cron_expr" = '0 0 6 * * *', "updated_at" = now()
 WHERE "dimension_key" = 'option_daily_snapshot';

UPDATE "marketdata"."sync_dependency"
   SET "mode" = 'soft'
 WHERE "upstream" = 'hk_option_contract'
   AND "downstream" = 'hk_option_daily_snapshot';
