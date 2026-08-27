-- 执行 lane expand: sync_dimension 增 queue_lane + seed 8 个 futu 维度。
-- expand-only (ADD COLUMN 带 NOT NULL DEFAULT + data-only UPDATE, 非破坏性) → 单 PR 合规
-- (ADR-0035 + migration-rules.md §2)。回滚不需要回退本 migration —— 读侧由灰度 flag
-- `MARKETDATA_FUTU_LANE_ENABLED` (默认 false) 控制, flag 关时本列**根本不被读**。
--
-- ══ 这一列解决的是队头阻塞, 不是限频 ════════════════════════════════════════════════
-- 现状: 全部维度 + 冷启动共用一个 `marketdata-sync` queue, worker `concurrency = 1`。而
--   限频是**在 job 内 sleep** 实现的 (`vendor-rate-limiter.ts` acquireOne → `await sleep`),
--   睡觉时占着唯一的 worker 槽 ⇒ futu 那 10 次/30s 的桶每次调用约 3s 纯睡眠, 期间理杏仁
--   整条链冻住; 反过来理杏仁那条 2h35m 的夜间链跑着时, futu 的桶完全空闲却用不上。
-- 实测后果 (issue #210): 港股期权三维 cron 在 23:00/23:00/23:30, 连续三晚**执行在午夜后**
--   (08-25 01:30 / 08-26 00:33 / 08-27 00:35)。快照本体只跑 5-6 秒, 三维合计约 37 秒 ——
--   2h35m 全花在排队。越过午夜后 `crossedIntoNextSession` 为真, 行被标成
--   `source = premarket_backfill` ⇒ 那个本该是「降级留痕」的值退化成每晚都有的噪声。
--
-- 🚨 **`priority` 列解决不了这个** —— 它只是 `deriveExecutionOrder` 里**同一个 tick 的 won
--   集**内部的 tie-break; 跨 tick 排序在 BullMQ 那边是纯 FIFO (`jobOpts()` 从不设 BullMQ
--   `priority`)。23:00 与 22:00 是两个 tick ⇒ 无论 priority 填什么都不改变排队顺序。
--
-- ══ 为什么另起一列而不复用 `vendor` ══════════════════════════════════════════════════
-- `vendor` 是**死的装饰列**, 其 schema 注释已自陈「代码从不读取本列」且语义停在 ADR-0047
--   2026-06-03 Amendment 之前。它的**值本身就不可信**: eod_bar 记 'lixinger', 而同一个
--   EOD_BAR_PORT 对 us 路由到富途。把它变成承重件, 要先把 21 个维度的值逐个复核对齐 DI
--   绑定 —— 那是另一件事, 且做错了不会有任何地方报错。新列从第一天起只有一个语义。
--
-- ══ 🚨 lane ≠ vendor 的一一对应, 别把它当成那个 ════════════════════════════════════════
-- `universe` 走 `UniverseFallbackChainAdapter([理杏仁, 富途, 东财])` —— 它**是个多 vendor
--   维度**, 所以「一条 lane = 一个 vendor」从来就不成立, 不能拿它当设计前提。
-- 之所以这不构成问题: **限频的真正 enforcer 是传输层的单例令牌桶, 不是队列并发度**。
--   `marketdata.module.ts` 里每个 `VendorHttpClient` 都是单例 provider, futu 还按 capability
--   拆了 5 个独立客户端 (general / option_chain / option_snapshot / earnings / market_state);
--   `VendorRateLimiter.acquire()` 用一条 tail promise 链把并发调用 FIFO 排队。⇒ 有几条 lane
--   并发对限频**完全无影响**。lane 的作用只有一个: 让 futu 的活不再排在理杏仁后面。
--
-- 🚫 **MUST NOT 按市场拆 lane** (cn/hk 各一条之类)。拆 lane 的收益全部来自「不同 vendor
--   互不排队」; cn 与 hk 共用同一个理杏仁令牌桶, 按市场拆只会让同一个桶被两条 lane 并发打,
--   是**反向**收益。判据永远是「共享哪个限频桶」。
--
-- ══ 为什么是这 8 行 ════════════════════════════════════════════════════════════════
-- 打 futu shim 的全部维度。us_index_daily 走 cboe、其余走理杏仁/东财, 留在 default。
-- ⚠️ `sync:anchor-cold-start` 不是维度、在本表无行, 它的 lane 由代码恒定为 'futu'
--   (它调的就是 futu 链发现与快照本体) —— 这正是「22:00 后建锚会被压过午夜、黄金窗口只剩
--   交易日 21:30-21:59」那条约束的来源, 顺带一并解掉。
--
-- migration_refs: issue #210 (港股期权三维执行在午夜后)
ALTER TABLE "marketdata"."sync_dimension"
  ADD COLUMN "queue_lane" VARCHAR(16) NOT NULL DEFAULT 'default';

-- 幂等 (重 deploy 同值覆盖零副作用); 未来新增 futu 维度须在此列表登记, 漏登记的后果是
-- 「落回 default lane」= 退化成现状, 不是坏数据 —— 这正是 DEFAULT 'default' 的用意。
UPDATE "marketdata"."sync_dimension"
   SET "queue_lane" = 'futu', "updated_at" = now()
 WHERE "dimension_key" IN (
   'hk_option_contract',
   'hk_option_daily_snapshot',
   'hk_underlying_iv_daily',
   'option_contract',
   'option_daily_snapshot',
   'underlying_iv_daily',
   'us_equity_bar',
   'earnings_event'
 );
