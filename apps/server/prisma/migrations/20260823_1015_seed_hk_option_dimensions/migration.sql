-- 066 T04 港股期权三个采集维度 seed (FR-015, plan §A1)。**纯 seed, 无 DDL**
-- —— 三张表 (option_contract / option_daily_snapshot / underlying_iv_daily) 早由
-- 20260804_1139 与 20260803_1210 建好, 港股不新建任何表。样板 = 20260804_1155。
--
-- ══ 为什么是三个**独立维度行**, 而不是给现役美股三行的 market_scope 加 'hk' ═════════════
-- `session-clock.ts` 的 `exchangeCalendarDateForScope` 在 scope 内各市场算出的日历日不同时
--   **直接 throw**: 北京 06:00 时 exchangeCalendarDate('us') = D-1 而 ('hk') = D ⇒ {us,hk}
--   当场炸。**该 throw 存在的目的就是禁止这种混用** (函数注释原文: 把「别往 cn/hk 维度里掺
--   us」那条散文约定变成机器强制)。
-- 即使绕过它, 第二个坑仍在: tick payload 无 `markets` 字段 ⇒ **混 scope 维度的工作集恒为全
--   scope**, 港股休市而美股开市的日子会对港股全量发请求。
-- 📌 反过来 `{cn,hk}` **不会抛** (现役 eod_bar 就是这个 scope) —— 判据是「算出来的日期相同」
--   而非「时区字符串相同」, Asia/Shanghai 与 Asia/Hong_Kong 恒为 UTC+8 且均无 DST。所以
--   「能不能并进某个现有维度」要逐个看它 scope 里有没有 'us', 别一刀切。
--
-- ══ cron 为什么全排在 23:00 (这就是 FR-015 的落地点) ══════════════════════════════════
-- 22:00 是仓里既有的**港股锚点**: eod_bar + 18 个理杏仁 cn/hk 维度全在这一刻, runbook 记
--   「22:00 起、当晚 ~22:30 就位」。BullMQ worker `concurrency = 1` ⇒ 那批要占用队列一段时间,
--   23:00 是留给它的余量。⚠️ 这条**不是**靠错峰保证不争 —— 单队列串行才是真保证 (T11);
--   冷启动是全系统唯一的非 cron 触发者、建锚时刻由人决定, 错峰对它无效。
-- 断言在 test/integration/marketdata-066.hk-dimension-seed.it.spec.ts, 且是**机械的**: 解析
--   cron_expr 断下一触发时刻晚于同日 22:00、早于次日 00:00。写死字符串比对会在有人改 cron 时
--   静默放行。
--
-- ── hk_option_contract (港股链合约发现) ───────────────────────────────────────────────
-- `batch_size = 1`: get_option_chain 是**单 code** 接口 (无批量), 且窗 ≤30 天 ⇒ 每票按到期日
--   贪心分窗多次调用 (港股实测: 腾讯 / 小米 8 个到期日, 海底捞 7, 药明康德 8)。
-- `history_depth` 留 NULL: 链发现取的是**当下可得的合约集**, 没有「回填多少天」这个概念
--   (vendor 不提供历史时点的链快照)。同 20260804_1155 的美股同名维度。
-- 工作集**不是**整个港股 universe —— 本维度是**锚作用域**的 (066 T02 登记在
--   `anchor-scoped-dimensions.rules.ts`): `{market ∈ scope, status:'active'} ∩ 锚集`,
--   `needSync` 不进谓词。🚨 顺序不可反 (排序铁律 2): 先 seed 再登记的话, 上线那一刻工作集
--   就是整个港股 universe, 单 code 接口 × 每票多窗会炸成小时级墙钟并占满 10/30s 的桶。
--   🚫 也**不能**靠把 'hk' 加进 ANCHOR_GATED_MARKETS 来收窄 —— 关闸路径 (notIn) 放到 cn/hk
--   会把全部 cn/hk 在市标的一次性移出工作集, 直接打死 22:00 那 18 个理杏仁维度 (SC-004)。
--
-- ── hk_option_daily_snapshot (港股全链逐日快照) ──────────────────────────────────────
-- 🚨 `enabled = false` **不是笔误** (FR-016, 排序铁律 5): HKEX 的 OI 归属日正在实测中 (U2
--   采样器, 08-25 出结论)。结论落地前翻开会让**持仓量整体偏一天且不报错** —— 采集全绿、库里
--   也确实有行, 只是 net_open_interest 归错了交易日, 而活跃度排名与 UI 的 asOf 都读它。
--   🚫 **绝不为了「让 SC-001 早点绿」提前翻它**。翻开是 T09 的收尾动作。
-- `batch_size = 400`: get_option_snapshot 官方批量上限 = 400 codes/批。⚠️ **别套 /kline 那个
--   最严兜底值** —— 当初把 kline 挂全局最严限额且逐页计数, 直接导致 08-01 回填事故 (p3b E38)。
-- `history_depth` 留 NULL: 期权 EOD **无跨日补救** (vendor 不提供历史交易日的期权快照,
--   漏采即永久缺口) ⇒ 本维度没有 backfill 语义。
-- `cron '0 30 23 * * *'` 比链发现晚 30 分钟 —— 依赖边保证的是**失败传播与执行序**, cron 错开
--   是同一约束在调度侧的第二道表达。
--
-- ── hk_underlying_iv_daily (港股标的级 IV 日快照) ────────────────────────────────────
-- 🚨 `history_depth = 1095` (约 3 年) **不是保守取值, 是一条性质的载体**: 单个 vendor 窗
--   (≤364 天) 港股只返 **244** 个交易日、美股 250 —— 两者都不足 IVP_MIN_WINDOW_TRADING_DAYS
--   = 252。只拉一年会让分位**恒为** `insufficient_window` **且不报错**。1095 保证回填跨 ≥2 窗
--   (走既有 splitBackfillWindows())。港股历史起点实测 2023-06-27, 总深约 3.15 年 / ~773 行。
--   seed 成别的值, 那条性质会**静默消失** —— 断言在 underlying-iv.rules.spec.ts (066 T08 的
--   HK_HISTORY_DEPTH_DAYS) 与本片的 seed IT 两处各钉一遍。
-- `batch_size = 500` 同美股同名维度 (overview 批量直读)。
-- `delta_lookback_days` 三行全留 NULL: 链 / 快照的端点不吃日期区间, overview 是**快照端点**
--   (问「现在」) ⇒ 回看窗对三者都无意义。与 20260801_2248 给区间型维度配回看窗的规则不冲突,
--   是端点形态不同。
--
-- 三行 `priority = 5` (同 047 的美股期权对): 派生全序的 tie-break 是「priority desc → key
--   字典序 asc」, 而 'eod_bar' < 'hk_option_contract' < 'hk_option_daily_snapshot' <
--   'hk_underlying_iv_daily' < 'option_contract' ⇒ ① 既有 hard 边 corporate_action→eod_bar 与
--   option_contract→option_daily_snapshot 的**相邻性**不受影响 ② 下面那条新 hard 边天然相邻。
--   ⚠️ 这不是随手填的: 任一行取 priority 6 就会插进 corporate_action→eod_bar 中间, 而 BullMQ
--   flow 装配对 hard 边有「在 won 链必须相邻」的硬约束 ⇒ **夜间 flow 装配运行期 throw**, 而
--   这条 seed 本身跑得绿绿的。反例已固化为 dimension-executor.spec.ts「066 T04 港股三维度
--   seed 的依赖拓扑守卫」。
-- 三行 `freshness_profile = 'continuous-daily'` + `sla_hours = 26` 同 047 三行。
-- `vendor = 'futu'` 仅记录建表意图; **代码从不读取该列** (见 schema.prisma 该列注释)。
--
-- ⚠️ **上线即零数据是预期的**: 三行全是锚作用域维度, 零港股锚时工作集为空、判定为**成功**、
--   vendor 请求数 = 0 (SC-002)。开闸靠建港股锚 (T06 起冷启动对 hk 开通)。
--
-- migration_refs: specs/066-hk-option-cold-start (FR-015 三维度 cron 排在 22:00 之后 /
--   FR-016 快照维度暂不开 / FR-018 IV 回填必须跨 ≥2 窗)

INSERT INTO "marketdata"."sync_dimension"
  ("dimension_key", "enabled", "cron_expr", "vendor", "market_scope", "adjust_types",
   "batch_size", "history_depth", "priority", "freshness_profile", "sla_hours")
VALUES
  ('hk_option_contract', true, '0 0 23 * * *', 'futu', '{hk}'::text[], '{none}'::text[],
   1, NULL, 5, 'continuous-daily', 26),
  ('hk_option_daily_snapshot', false, '0 30 23 * * *', 'futu', '{hk}'::text[], '{none}'::text[],
   400, NULL, 5, 'continuous-daily', 26),
  ('hk_underlying_iv_daily', true, '0 0 23 * * *', 'futu', '{hk}'::text[], '{none}'::text[],
   500, 1095, 5, 'continuous-daily', 26)
ON CONFLICT ("dimension_key") DO NOTHING;

-- universe → 链发现 / 标的 IV 的 **soft** 边 (同 047 美股先例): 两者都 FK→instrument, 标的须
-- 先注册才有 instrument_id 可挂, 但 universe 缺席/失败不该拖垮它们 (universe→* 全 soft 是第一道
-- 拦截, 017 先例)。🚨 soft 边**只定执行序、不构成工作集闸** —— 港股这两个维度的闸是**锚集**
-- (066 T02 的 ANCHOR_SCOPED_DIMENSIONS), 不是这条边。
--
-- 🚨 **hk_option_daily_snapshot 刻意没有 universe 边** (照抄 047 的同一条理由): 它的工作集来自
-- option_contract 而不是 Instrument; 且多一条入边会让它在 Kahn 拓扑里多一个前驱, 与下面那条
-- hard 边争相邻位。传递依赖 universe → hk_option_contract → hk_option_daily_snapshot 已足够。
INSERT INTO "marketdata"."sync_dependency" ("upstream", "downstream", "mode")
VALUES
  ('universe', 'hk_option_contract', 'soft'),
  ('universe', 'hk_underlying_iv_daily', 'soft')
ON CONFLICT ("upstream", "downstream") DO NOTHING;

-- 港股快照 **hard** 依赖港股链发现: 无合约表即无从取快照 ⇒ 链发现失败必须断下游
-- (failParentOnFailure), 不能让快照拿着空/陈旧的合约集照跑。
-- ⚠️ hard 边要求两端在派生全序里**相邻** (assertEdgesExpressible), 这由两者 priority 同为 5
-- 且同 priority 下 'hk_option_daily_snapshot' 是 'hk_option_contract' 之后字典序最小的 ready
-- 项保证 —— 见 dimension-executor.spec.ts「066 T04 港股三维度 seed 的依赖拓扑守卫」。
-- 🚨 **跨市场不连边**: option_contract 与 hk_option_contract 之间**没有**任何依赖边, 两者串行
-- 不争配额靠的是「同一个 marketdata-sync 队列 + worker concurrency=1」这个结构事实 (T11),
-- 不是依赖图。连一条边会把「美股链发现失败」传播成「港股当晚不采」, 那是两码事。
INSERT INTO "marketdata"."sync_dependency" ("upstream", "downstream", "mode")
VALUES ('hk_option_contract', 'hk_option_daily_snapshot', 'hard')
ON CONFLICT ("upstream", "downstream") DO NOTHING;
