-- 047 optionsdesk M2b 三个新采集维度 seed (p3b §4.4 表 + plan D-DATA-1)。**纯 seed, 无 DDL**
-- —— 表由 20260804_1139 建。样板 = 20260731_2230_seed_us_equity_bar_dimension。
--
-- cron `0 0 6 * * *` (Asia/Shanghai) 与 us_equity_bar / underlying_iv_daily **同档**:
-- 北京 06:00 = 前一交易日 18:00 EDT / 17:00 EST, 两者都在 16:00 美股收盘之后 ⇒ 固定 cron
-- 全年成立, 无需跟 DST 调。
-- ⚠️ 配套前提: tick 的 `asOf` 按**市场时区**求值 (`marketDateFor`, FR-036 / plan D-DATA-10)。
-- 退回全局 `shanghaiToday` 会让三个维度日期错位一天且每周固定丢掉周五。
-- ⚠️ 采集触发的**开市判定走交易日历**而非固定时钟 (US 半日市收盘提前) —— 由 tick 的
-- per-market 交易日闸承担, 这也是三行都必须写 `market_scope = {us}` 的原因之一。
--
-- ── option_contract (链合约发现) ──────────────────────────────────────────────────────
-- `market_scope = {us}` 在这里**既是元数据也是工作集判据**: 走锚白名单 (继承 need_sync 采集
--   闸) ⇒ **无锚不采** (FR-035), 加第 13 只锚零代码自动纳入。否则工作集从十几只炸到 19,465
--   只 us 标的, 实算需约 44 小时墙钟, 日更任务永远跑不完。
-- `batch_size = 1`: `get_option_chain` 是**单 code** 接口 (无批量), 且窗 ≤30 天 ⇒ 每票要按
--   到期日贪心分窗多次调用 (实测「5–12 月 8 个到期日 = 5 次调用」, FR-029)。
-- `history_depth` 留 NULL: 链发现取的是**当下可得的合约集**, 没有「回填多少天」这个概念
--   (vendor 不提供历史时点的链快照)。不设到期日上限、含 LEAPS (FR-032)。
-- `delta_lookback_days` 留 NULL: 同上 —— 端点不吃日期区间, 回看窗对它无意义
--   (与 20260801_2248 给区间型维度配回看窗的规则不冲突, 是端点形态不同)。
--
-- ── option_daily_snapshot (全链逐日快照) ──────────────────────────────────────────────
-- 同样**挂锚闸**(per-code 接口), 且 **hard 依赖链发现** (无合约表即无从取快照, FR-031)。
-- `cron '0 30 6 * * *'` 比链发现晚 30 分钟 —— 依赖边保证的是**失败传播与执行序**, cron 错开
--   是同一约束在调度侧的第二道表达 (链发现约 12 票 × 5 次 ÷ 10 次每 30s ≈ 3 分钟, 30 分钟宽裕)。
-- `batch_size = 400`: `get_option_snapshot` 官方批量上限 = 400 codes/批 (plan D-SHIM), 限频
--   60/30s。⚠️ **别套 `/kline` 那个最严兜底值** —— 当初把 kline 挂全局最严限额且逐页计数,
--   直接导致 08-01 回填事故 (p3b E38)。新端点一律按各自官方值配。
-- `history_depth` / `delta_lookback_days` 留 NULL: 期权 EOD **无跨日补救** —— vendor 不提供
--   历史交易日的期权快照, **漏采即永久缺口**。所以本维度没有 backfill 语义, 兜底手段是
--   FR-046 的次日盘前补采 (走 source='premarket_backfill' 另落一行, 不是回填区间)。
--
-- ── earnings_event (财报日历) ─────────────────────────────────────────────────────────
-- 🚨 `market_scope = {us}` 在这里**只是元数据** (供 tick 的 per-market 交易日闸用),
--   **工作集不由它推导** —— 工作集 = **固定的前向时间窗序列** (按 vendor ≤7 天窗上限分窗覆盖
--   可得视野, 约 26 次调用/天), **不查锚表、不挂锚闸** (FR-035a / plan D-DATA-1)。
--   判据是「接口是不是 per-code」: `get_earnings_calendar(US)` 单次返**全市场**, 调用数只跟
--   前向视野有关、**与锚有几只完全无关** ⇒ 锚闸零收窄作用, 挂了只会复刻「零锚时静默不采」。
--   **这是 046 已订正过一次的同形状问题** (FR-026 → FR-027), 本片是第三次。
--   ⇒ 它的 executor **不复用 `factExecutor`** (那条路径先 `loadActiveInstruments`)。
-- 🚨 `priority = 4` 而不是跟其余 us 维度一样的 5 —— **这不是随手填的**: 派生全序的 tie-break
--   是「priority desc → key 字典序 asc」, 而 'earnings_event' < 'eod_bar'; 取 5 会让它插进既有
--   hard 边 `corporate_action → eod_bar` 中间, 而 BullMQ flow 装配对 hard 边有「在 won 链必须
--   相邻」的硬约束 ⇒ **夜间 flow 装配运行期 throw**, 而这条 seed 本身跑得绿绿的。
--   该反例已固化为 dimension-executor.spec.ts 的「047 T003 依赖拓扑守卫」断言。
-- `batch_size = 1`: 市场级接口, 批量语义不适用 (同 us_index_daily)。
-- `history_depth` 留 NULL: 前向视野是**向前**的, 而 history_depth 是**向后**回填窗, 概念不同;
--   前向视野由 executor 自己按 ≤7 天窗推进 (每日重拉整个视野, FR-034 / plan D-DATA-9)。
--
-- 三行 `freshness_profile = 'continuous-daily'`: 🚫 财报维度**不能**取 'event-calendar' ——
--   那个画像会让 tick 在「日历未命中」时 skip, 而本维度是**每日重拉整个前向视野**, 每天都必须
--   跑 (PIT diff 要发现的是「已公布的日期被改了」, 少跑一天就少一天观察)。
-- `sla_hours = 26` 同其余 us 维度 (新鲜度基准是 SyncRun 的最近成功时刻, 按交易日历折算)。
-- `vendor = 'futu'` 仅记录建表意图; **代码从不读取该列** (见 schema.prisma 该列注释)。
--
-- ⚠️ **上线即零数据是预期的** (前两个维度): 全部 us 标的 need_sync 默认 false (无锚不采,
--   migration 20260730_1600)。开闸靠锚驱动, 本 migration 不动闸。财报维度反之 —— 零锚也照常
--   跑并落库 (FR-035a 的反向守卫)。
--
-- migration_refs: specs/047-optionsdesk-chain-leg-picker (FR-035 两个 per-code 维度挂锚闸 /
--   FR-035a 财报不挂锚闸 / FR-031 快照 hard 依赖链发现 / FR-036 us 时区业务日期 / FR-055
--   三个维度全部登记在 marketdata 名下)

INSERT INTO "marketdata"."sync_dimension"
  ("dimension_key", "enabled", "cron_expr", "vendor", "market_scope", "adjust_types",
   "batch_size", "history_depth", "priority", "freshness_profile", "sla_hours")
VALUES
  ('option_contract', true, '0 0 6 * * *', 'futu', '{us}'::text[], '{none}'::text[],
   1, NULL, 5, 'continuous-daily', 26),
  ('option_daily_snapshot', true, '0 30 6 * * *', 'futu', '{us}'::text[], '{none}'::text[],
   400, NULL, 5, 'continuous-daily', 26),
  ('earnings_event', true, '0 0 6 * * *', 'futu', '{us}'::text[], '{none}'::text[],
   1, NULL, 4, 'continuous-daily', 26)
ON CONFLICT ("dimension_key") DO NOTHING;

-- universe → option_contract / earnings_event 的 **soft** 边 (同 us_equity_bar /
-- underlying_iv_daily 先例): 两者都 FK→instrument, 标的须先注册才有 instrument_id 可挂, 但
-- universe 缺席/失败不该拖垮它们 (universe→* 全 soft 是第一道拦截, 017 先例)。
-- 🚨 soft 边**只定执行序、不构成工作集闸** —— 别把 universe→earnings_event 读成给财报维度挂了
-- 锚闸 (FR-035a 明禁)。零锚时 universe 照跑、财报照跑。
--
-- 🚨 **option_daily_snapshot 刻意没有 universe 边**: 它的工作集来自 option_contract 而不是
-- Instrument, 与 universe 无直接数据依赖; 且多一条入边会让它在 Kahn 拓扑里多一个前驱, 与下面
-- 那条 hard 边争相邻位。传递依赖 universe → option_contract → option_daily_snapshot 已足够。
INSERT INTO "marketdata"."sync_dependency" ("upstream", "downstream", "mode")
VALUES
  ('universe', 'option_contract', 'soft'),
  ('universe', 'earnings_event', 'soft')
ON CONFLICT ("upstream", "downstream") DO NOTHING;

-- 快照 **hard** 依赖链发现 (FR-031): 无合约表即无从取快照 ⇒ 链发现失败必须断下游
-- (failParentOnFailure), 不能让快照拿着空/陈旧的合约集照跑。
-- ⚠️ hard 边要求两端在派生全序里**相邻** (assertEdgesExpressible), 这由两者 priority 同为 5
-- 且同 priority 下 'option_daily_snapshot' 是 option_contract 之后字典序最小的 ready 项保证
-- —— 见 dimension-executor.spec.ts「047 T003 依赖拓扑守卫」的相邻性断言。
INSERT INTO "marketdata"."sync_dependency" ("upstream", "downstream", "mode")
VALUES ('option_contract', 'option_daily_snapshot', 'hard')
ON CONFLICT ("upstream", "downstream") DO NOTHING;
