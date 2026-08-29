-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- marketdata 表级数据健康谓词 —— **单一共享产物 / 唯一判断所在地**（照 044 交易日历探针范式）。
--
-- 🚨🚨 这个文件是宪法 §II 合规的承重墙，动它前先读完本段。
--
-- 仓内无 bash 测试框架 → `marketdata-table-health.sh` 无法 RED-first，直接撞宪法 §II（NON-NEGOTIABLE）。沿用 044
-- 的裁决 = **把 bash 压到零逻辑**：所有判断下沉到本谓词，bash 只剩「跑它 → `exit $exit_code`
-- → 打印 summary」。
--
--   ⇒ 消费方 **一律读本文件**，**禁止**在 bash / IT / 任何地方内联复制一份 SQL。
--     两份必 drift，一 drift「判断逻辑已被真测」就当场变成假话，§II 合规名存实亡。
--
-- 已知消费方（改谓词 = 同时改这些的行为）：
--   · `apps/server/test/integration/marketdata.table-health.it.spec.ts`（**真测本文件**）
--   · `ops/jobs/marketdata-table-health.sh`（独立探针，每 4h）
--
-- **自包含 / 无参数**（阈值与清单写死在下面）：传参 = 把判断挪回 bash = 前功尽弃。
-- 契约（bash 零逻辑的前提，由 IT 断言锁死）：恒返 **单行两列** `exit_code` `summary`；
-- `exit_code ∈ {0,1}` 直接就是退出码；`summary` 单行、无 tab/换行 → 单次 `read` 即可解析。
--
-- ═══ 它为什么存在（2026-08-01 的事故，别让它重演）═══
--
-- 四个维度在 prod 静默丢数、`SyncRun` 连续十几天全绿无人发现：`announcement` 停 12 个交易日、
-- `buyback` 同期零增量、`shareholder_change` 一周只采 1/7、`fund_holding` 上线 18 天 0 行。
-- 三道既有防线全部漏判 —— `alertIfDegraded` 只看 `failed`、`FreshnessSlaCheck` 量的是 **run 年龄**
-- 而非**数据年龄**（跑了但没产出 → run 永远新鲜）、`rowsFetched` 全仓只有一处埋点。
-- ⇒ 判据必须挂在**数据**上、且跑在**采集进程之外**。这就是本探针。
--
-- ═══ 判据（**任一成立即不健康 → exit 1**）═══
--   ① 哨兵陈旧：某维度的**全部**哨兵票都拿不到「不早于 expected_day」的行
--   ② us 正股日线掉队：`need_sync` 的 us 票**任一只**拿不到新 `daily_bar`
--   ③ us 标的级 IV 停摆：`need_sync` 的 us 票**全部**拿不到新 `underlying_iv_daily`（AND，别写成 ②）
--   ④ us 空工作集：`need_sync=true` 的 us 票为 0（「空工作集」也是要抓的签名之一）
--   ⑤ 指数缺数：VIX / VVIX **任一个**拿不到新 `us_index_daily`
--   ⑥ 日历缺失：算不出 expected_day（`trading_day` 未填充到位）→ 判不健康，不静默放行
--   ⑦ 期权到期阶梯截断：有合约的 us 锚**任一只**拿不到 ≥ today+120d 的到期日（047 FR-050）
--   ⑧ 期权快照掉队：有合约的 us 锚**任一只**拿不到新 `option_daily_snapshot`（047 FR-050）
--   ⑨ 财报视野塌陷 / 停止观察：前向视野右端 < today+120d，或 5 个交易日无新 `first_seen_at`
--   ⑩ 磁盘水位：可用空间 < 实测日均增长 × 90 天（047 FR-052a）
--   ⑪ 跨市场幽灵合约：同一合约标识同时挂在 us 与 hk 标的名下（#199；与「词根撞名报数」是两件事）
--   ⑫ OI 归属标签漂移：按合约**真实市场**重算的 `oi_as_of` 与库里的值不符（#262；市场通用）
--   ⑬ 带内零哨兵残留：`(bid,bid_size)`/`(ask,ask_size)` 成对为 0，或 `last`/`prev_close`/
--      `underlying_spot` 为 0（#262 交付面 ③ / ADR-0067 —— 那不是价格，是「没有这个价」）
--
-- ═══ 为什么是「逐票哨兵 EXISTS」而不是「全表 max(date) + 行数下界」═══
-- 🚨 **性能是硬约束，不是优化偏好**：被监控表的索引一律 `(instrument_id, date)` 前导，**没有任何
--    date 前导索引** ⇒ `SELECT max(date) FROM volatility_daily` 是**全表扫 1590 万行 / 1.9 GB**。
--    77 上可用内存仅 ~580 MB 且无 swap，每 4h 冲一次 page cache = 探针自己变成事故源。
--    逐票 `EXISTS (... WHERE instrument_id = ? AND date >= ?)` 走 uk 索引，毫秒级。
--    ⇒ 若日后想改回聚合判据，**先加 date 前导索引**，否则别改。
-- 另一层理由：行数下界本就是弱判据 —— 总数会被大票掩盖小票掉队（p3b §5.2-2 已论证）。
--
-- ═══ 覆盖边界（**说清楚没覆盖什么，比夸大覆盖面重要**）═══
-- 本批只抓「**维度级停摆**」（整个维度不再产出新数据），**不抓「单票掉队」** —— cn/hk 侧哨兵取
-- **AND 语义**（全部哨兵都陈旧才判红），个股停牌/退市不会误报，代价是单票消失看不见。
-- 逐票完整性的严格版属期权链范畴（p3b §5.2-2），随 p4 落，不在本批。
--
-- 🚨 **us 侧两个标的级维度共用同一个工作集（`need_sync` 白名单），语义却相反 —— 别照抄错**：
--   · `us_equity_bar` → **OR**（任一只掉队即红）。白名单只有个位数、每只都是 045 雷达的锚定
--     标的，且**美股票必然有日线** ⇒ 单票缺行没有正常态解释，就是真故障。
--   · `underlying_iv_daily` → **AND**（全部陈旧才红）。两条理由缺一不可：
--       ① `get_option_underlying_overview` 是**批量快照端点**（一次问 ≤500 codes），失败是
--          **批级 all-or-nothing** ⇒ 逐票 OR 在这里拿不到任何额外检出力；
--       ② 单票缺行有一个**正常态来源** —— 该标的**没有挂牌期权**时 vendor 整行缺席，
--          `dimension-executor.syncUnderlyingIvDaily` 把它计 `skipped` 而非 `failed`，是写进
--          端口契约的显式行为。取 OR ⇒ 锚表里一旦出现无期权标的，每 4h 一条永久假红。
--     代价与 cn/hk 侧同：单票掉队看不见（2026-08-04 定，user 拍板）。
--
-- 🚨 `underlying_iv_history` **蓄意不在监控面内**：它只在 backfill 模式下由 `his_volatility`
--    分页回填（delta 路径 `input.mode === 'backfill'` 早退才走它）⇒ 它**不是逐日增长的序列**，
--    「数据年龄」判据对它根本不成立，纳进来 = 长期假红。它的完整性由回填时的分页断言守。
--
-- 未纳入本批的维度及理由见 `ops/runbook/scheduled-tasks.md` 对应段（报告期语义 / 覆盖式 upsert /
-- 稀疏事件流三类都不适用「数据年龄」判据，硬塞进来只会制造长期噪音）。
--
-- ═══ 047 M2b 三个新维度：为什么两条走「前向覆盖」而不是「时间戳年龄」═══
--
-- 🚨 `option_contract` **没有可用的时间戳年龄判据** —— 链发现是
--    `createMany({ skipDuplicates: true })` 幂等落行（`sync-option-contract.usecase.ts`），
--    **稳态下一行都不写**（当天没新挂到期日 = 零写入）。拿 `updated_at >= expected_day` 判
--    = 每天假红一次，且长得像真故障。同理 `created_at`。
--    ⇒ 判据改挂**数据自身的前向覆盖**：每只有合约的锚必须存在 `expiry_date >= today + 120d`
--    的合约。它抓的是真实故障形态「**窗序列跑到一半 budget 耗尽 → 该票到期阶梯被截断**」——
--    截断后近端仍有合约、快照照采，其余所有防线都看不见这个缺口。
--    120d 的取值依据：标准美股期权链恒含两个近月 + 季度循环月（正常态约 7–8 个月），再往上
--    还有 LEAPS ⇒ 120d 是**下界留一倍余量**，不是拍的百分比。若某只白名单票确实没有 4 个月
--    以外的到期日，**单独放宽这一条**，别动另外两个。
--    ⚠️ 覆盖边界：它抓不到「阶梯右端在但中间某几个到期日漏采」——那属逐合约完整性，归
--    `ops/jobs/marketdata-snapshot-integrity.{sh,sql}`（047 T025a）。两个探针分工，别在这里重复实现。
--
-- `option_daily_snapshot` 走标准的**数据年龄**（`session_date >= expected_day`，lag 2 同
--    us_equity_bar：三者都排在北京 06:00 之后）。
--
-- 🚨 这两条取 **OR**（有票掉队即红）而**不是** `underlying_iv_daily` 那种 AND —— 工作集不取
--    `need_sync` 白名单本身，而是**其中已经有合约的那些票**：没挂期权的锚（AND 语义存在的
--    全部理由）在这里已经被工作集本身滤掉了 ⇒ 剩下的每一只都必然该有数据，OR 不会假红。
--    工作集取自 `option_contract` 不构成循环信任：链发现整体死掉时该表不会凭空多出行，
--    工作集只会停在旧值（判据照常成立）或归零（→ 空工作集判红，见下）。
--
-- `earnings_event` 是**市场级**维度（不挂锚闸，FR-035a），故无逐票工作集，两条信号并联：
--    · **前向视野右端** `max(earnings_date) >= today + 120d` —— 抓「26 个窗只跑了一半」
--      （vendor 视野约 6 个月，腰斩后右端约 90d < 120d 即红）。
--    · **最近一次新观察** `max(first_seen_at)` 不老于 **5 个交易日** —— 抓整体停摆（只靠上面
--      那条要等约 60 天才红，太慢）。⚠️ **这是本批最不确定的一条**：它假设全市场每周至少有
--      一条新观察到的 `(标的, 财报日)`。若实测在长假出现假红，**单独放宽这一条的 lag**。
--
-- ═══ ⑩ 磁盘水位（FR-052a）：阈值是算出来的，不是拍的 ═══
--
-- 判据 = **可用空间 < 实测日均增长 × 90 天**（等价于「剩余可撑天数 < 90」）—— 留出不少于
-- 90 天的人工扩容窗口。🚫 MUST NOT 拍百分比（FR-052a 明写）。
--
-- **实测日均增长 = 047 三表当前总字节 ÷ 快照已积累的交易日数**，每次跑现算。
--   ⚠️ 与 tasks 原文「由探针滚动计算并**回写**」的差异是**蓄意的**：现算等价于「每次都用最新
--      观测重算」，且省掉一张状态表 + 一条写路径。本探针的结构性前提是**只读取证**（FR-051），
--      给它开写路径会同时削弱「独立于采集进程」和「纯 SELECT 无副作用」两条论证。
--   · **样本不足 10 个交易日 → 判「样本不足」，不告警**（上线首两周的正常空态；显式写进
--     summary，不静默）。10 这个门槛是 FR-052a 给的。
--   · 交易日数**从 `trading_day` 数**（小表）而不是在快照表上 `count(DISTINCT session_date)`
--     —— 后者是 6.4M 行/年 的全表扫，探针自己会变成事故源（同文件头那条性能硬约束）。
--     `min/max(session_date)` 走 `ix_option_daily_snapshot_session_date`，毫秒级。
--   · **覆盖边界**：日均增长只量 047 三表（本仓第一个**无上限线性增长**的数据面，正是 FR-052a
--     的存在理由）。其余 22 个维度的增长**不在内** ⇒ 算出的「可撑天数」是**上界**，真实耗尽更早。
--     要把全库纳入需要一条持久的容量时间序列，本片不做。
--
-- 🚨 **本谓词唯一的入参 `:avail_kb`**（PG 数据卷的可用 KB）——PostgreSQL 没有任何读文件系统
--    剩余空间的内建能力，这个数只能由 OS 侧量。它是**观测值不是判断**：阈值、比较、90 天窗
--    全部还在本文件里，`check.sh` 仍是零逻辑（它只跑一次 `df` 把数字递进来）。
--    副作用是这条判据**反而成了最好测的一条** —— IT 直接注入低余量即可要求翻红。
--    未定义 / 空值 → SQL 语法错 → `ON_ERROR_STOP` 非零退出 → 告警（fail-closed，不静默放行）。
--
-- ═══ ⑫ OI 归属标签（#262）：本文件唯一一条「重算应然值」型判据 ═══
--
-- 其余判据问的都是「数据够不够新 / 在不在」。本条问的是「**这一行的标签对不对**」——
-- 按合约的**真实市场**把 `oi_as_of` 重算一遍，与库里的值比对，不符即红。
--
-- 它补的洞（#255 实证）：`option-snapshot-coverage` 的查询缺市场谓词 ⇒ 港股合约混进美股分母
-- ⇒ 08:00 那轮拿 `marketScope:['us']` 把 hk:00700 整票重采，按**美股**语义写 `oi_as_of`
-- ⇒ **1110 行标签错一天**。三层防线全绿：唯一键第三段是 `source`，两套语义的行可以并存；
-- 读侧按 `max(quote_as_of)` 去重时错的那份还恒定胜出。⇒ 值对、标签错，且不报错。
--
-- 🚨 **判据是 `oiRefreshedAtEod` 的第三处表达**（另两处：`market-session.rules.ts` 的
--    `MARKET_OI_SETTLE_LOCAL_MINUTE` 登记表、`sync-option-snapshot.usecase.ts` 的写路径）。
--    改任一处必须同步本条，否则表现是「探针天天红而代码是对的」或反过来。同 ⑪ 与它那条
--    清理 migration 的关系。
--
-- ═══ 常量 `21:30` 的证据状态（说清楚哪一半没验实）═══
--   ✅ **市场分叉本身已验实**（2026-08-28，独立于 vendor）：库里 session `2026-08-26` 那批
--      （`08-27 00:35` 采）的腾讯类 OI 汇总 `2,577,304 / 1,440,340 / 1,136,964` 与 HKEX 官方
--      日报 `dqe260826` **逐位相同**。若港股走美股那套 T+1，它装的该是 08-25 的数。
--   ❌ **那个「分钟」没有交易所证据**：只有一次内部采样把它夹在 (16:30, 21:30] 内，取的是
--      窗口上沿（保守侧：猜早了是「数字与标签双错」，猜晚了只是标签偏早、一条 UPDATE 可订正）。
--      本轮独立验到的上界是 22:04（vendor 实时已是 D 口径）/ 22:10（HKEX 报表已在线）。
--   📌 **但它对当前所有生产行的判决不敏感**：三条采集路径（夜链 23:00 · ① 级 23:40 ·
--      ② 级次日 08:30）全部落在任何候选边界**之后** ⇒ 常量取 [16:30, 23:00) 内任何值，判决相同。
--      唯一会落进 16:10–21:29 的是**建锚冷启动**，而 `anchor_cold_start_run` 全表 hk 三条
--      （15:45 / 22:02 / 22:07）**无一落在该窗口**。⇒ 该窗口今天是空的，日后若被打中，本条
--      在那一档会与代码一起错（**不会误报**，只是看不见），修法是先验实边界再改上面那张登记表。
--
-- ═══ 覆盖边界与性能（两者是同一个决定）═══
-- 🚨 窗口 = **最近 3 个交易日**（`oi_prev` 的 `rn <= 3`）。`option_daily_snapshot` 是全库增长
--    最快的表（约 6.4M 行/年），**全表**重算实测 1.7s 且随年份线性劣化 —— 撞文件头那条性能
--    硬约束。2026-08-29 实测（本谓词整体，同库连跑取稳态）：
--      不含本条 420ms │ K=2 646ms(19.1万行) │ **K=3 737ms(28.1万行)** │ K=5 936ms(46.2万行)
--    📌 **限窗后开销不随年份增长**：窗口以「交易日个数」计而非行数 ⇒ 判定面恒为
--       `3 × 每场行数`（现约 9.4 万/场），与历史长度无关。它只随**锚数**增长。
--    K=3 的依据：探针每 4h 一跑（每天 6 次），窗口给出 2–3 个交易日 ⇒ 每个脏批有 12–18 次
--    被看见的机会。K=5 多花 200ms 买不到额外检出力。
--    ⇒ **窗口外的旧行不判**（历史脏行由一次性 migration 清，不是探针的活）。
-- 🚨 `oi_prev` 必须 `MATERIALIZED`：PG12+ 对单引用 CTE 自动内联，会把「上一交易日」变成
--    **逐行相关 SubPlan**（36 万行 × 索引查），实测 buffer 从 1.8 万涨到 **290 万**。别摘掉它。
-- 空窗口（判定面 0 行）→ 判绿。本条是**正确性**判据不是 liveness ——「有没有在长」由 ⑧ 管，
--    形态同 ⑪（`count > 0` 才红）。
-- fail-closed：日历不足以给出「上一交易日」（`prev_td` 为 NULL）时，`IS DISTINCT FROM` 让
--    该行落进 `NOT ok` ⇒ 判红，而不是因为「算不出来」而静默放行。
--
-- ═══ 阈值 ═══
-- `max_lag_trading_days` = 允许落后多少个**交易日**（非自然日，长假不误报）。
--   · T+0 维度取 2：交易日当天 22:00 采集前，最新数据本就是上一交易日（lag 1）→ 留 1 天余量
--   · `connect_holding` 取 3：南向持股 T+1 披露，正常态即 lag 1~2
--   · us 三个维度（`us_equity_bar` / `underlying_iv_daily` / `us_index_daily`）同取 2、**共用
--     `us_expected`**：三者都是北京 06:00 采集（= 上一美股交易日 18:00 ET，收盘之后）⇒ 正常态
--     数据日期 = 最近一个已收盘的美股交易日。⚠️ 该档在 us 上**余量比 cn/hk 薄**：Shanghai 侧的
--     `today` 通常已比数据日期多一个美股交易日 ⇒ 稳态恰压在阈值上沿，漏跑一轮次日即红。方向
--     是**偏保守**（宁可早报），且与既有 `us_equity_bar` 一致 ⇒ 不为新维度单独放宽。
-- 触发时机 = 数据落后 3 个交易日 ≈ 故障后 2 天内告警。对照本次事故（12 个交易日无人知），够用。
--
-- 🚨 沉默 ≠ 健康：由固定清单 `VALUES` **LEFT JOIN** instrument 驱动 —— 哨兵票不在库 / 日历算不出
--    expected_day / 表整个空，全部落到 `has_fresh = false` 判红，绝不因「查不到东西」而静默放行。
-- ─────────────────────────────────────────────────────────────────────────────────────────────
WITH today AS (
  -- 业务「今天」锚在 Asia/Shanghai（与 app 的 marketDateFor 对齐；容器 TZ 若为 UTC 会差 8h，
  -- 而阈值以「交易日」为单位、余量 ≥1 天，该偏移不影响判定）。
  SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date AS d
),
-- 🚨 **加新维度进本谓词的时序**：先确认该维度已在 prod **跑出过至少一轮数据**，再把改动装到
--    77（`cp ops/jobs/marketdata-table-health.{sh,sql} …`）。反过来 = 装机即假红，每 4h 推一条，直到首跑。
--    （2026-08-04 扩 046 两个新维度时的实况：代码合入时它们的首跑还在几小时后。）
--
-- 哨兵清单：每维度 2 只**长期必然有数据**的代表票（2026-08-01 prod 实测全部在库且新鲜）。
-- cal_market = 用哪个市场的交易日历折龄；sym_market/code = 哨兵票的业务主键。
watched(dim, cal_market, sym_market, code, max_lag_trading_days) AS (
  VALUES
    ('eod_bar',         'cn', 'cn', '600519', 2),
    ('eod_bar',         'cn', 'cn', '000651', 2),
    ('eod_bar',         'hk', 'hk', '00700',  2),
    ('eod_bar',         'hk', 'hk', '00005',  2),
    ('connect_holding', 'hk', 'hk', '00700',  3),
    ('connect_holding', 'hk', 'hk', '00005',  3),
    ('short_selling',   'hk', 'hk', '00700',  2),
    ('short_selling',   'hk', 'hk', '00005',  2),
    ('volatility',      'hk', 'hk', '00700',  2),
    ('volatility',      'hk', 'hk', '00005',  2),
    ('fundamental',     'cn', 'cn', '600519', 2),
    ('fundamental',     'cn', 'cn', '000651', 2),
    ('fundamental',     'hk', 'hk', '00700',  2),
    ('fundamental',     'hk', 'hk', '00005',  2)
),
-- 各市场按日期倒序编号的交易日（rn=1 即最近一个 <= today 的交易日）。trading_day 是小表且
-- pkey (market, date) 覆盖此查询。
cal AS (
  SELECT t.market, t.date, row_number() OVER (PARTITION BY t.market ORDER BY t.date DESC) AS rn
  FROM marketdata.trading_day t, today
  WHERE t.date <= today.d
),
-- 每个哨兵的 expected_day = 允许落后 N 个交易日后的那一天。日历不足 → NULL → 下游判红。
deadline AS (
  SELECT w.dim, w.cal_market, w.sym_market, w.code, w.max_lag_trading_days,
         (SELECT c.date FROM cal c WHERE c.market = w.cal_market AND c.rn = w.max_lag_trading_days + 1)
           AS expected_day
  FROM watched w
),
-- 逐哨兵取新鲜度。EXISTS + `>= expected_day` 而非 `= 某日`：个股当日停牌不该判成维度故障。
-- expected_day IS NULL 或哨兵票不在库 → 比较结果非真 → has_fresh=false（fail-closed）。
probe AS (
  SELECT d.dim, d.cal_market, d.code, d.expected_day,
         CASE d.dim
           WHEN 'eod_bar' THEN EXISTS (
             SELECT 1 FROM marketdata.daily_bar b
             WHERE b.instrument_id = i.id AND b.trade_date >= d.expected_day)
           WHEN 'connect_holding' THEN EXISTS (
             SELECT 1 FROM marketdata.connect_holding_daily c
             WHERE c.instrument_id = i.id AND c.date >= d.expected_day)
           WHEN 'short_selling' THEN EXISTS (
             SELECT 1 FROM marketdata.short_selling_daily s
             WHERE s.instrument_id = i.id AND s.date >= d.expected_day)
           WHEN 'volatility' THEN EXISTS (
             SELECT 1 FROM marketdata.volatility_daily v
             WHERE v.instrument_id = i.id AND v.date >= d.expected_day)
           WHEN 'fundamental' THEN EXISTS (
             SELECT 1 FROM marketdata.fundamental_snapshot f
             WHERE f.instrument_id = i.id AND f.date >= d.expected_day)
         END AS has_fresh
  FROM deadline d
  LEFT JOIN marketdata.instrument i ON i.market = d.sym_market AND i.code = d.code
),
-- cn/hk 侧 AND 语义：某 (维度, 市场) 的**全部**哨兵都陈旧才判红（个股停牌不误报，见上「覆盖边界」）。
-- 🚨 **必须按 (dim, market) 聚合，不能只按 dim**：`eod_bar` / `fundamental` 的 marketScope 是
--    {cn,hk}，只按 dim 聚合时 cn 侧整个挂掉会被 hk 侧的健康值**平均掉**判绿 —— 044 探针的
--    「不被健康市场平均掉」是同一条教训。本项由 IT「同维度两只哨兵全陈旧 → exit 1」守着
--    （2026-08-02 首版就是按 dim 聚合，被该用例当场抓出）。
-- ⇒ 推论：**每个 (dim, market) 至少配 2 只哨兵**，否则 AND 退化成单点、个股停牌即误报。
dim_verdict AS (
  SELECT dim || ':' || cal_market AS scope,
         count(*) AS sentinels,
         count(*) FILTER (WHERE has_fresh) AS fresh_cnt,
         count(*) FILTER (WHERE has_fresh) = 0 AS unhealthy,
         max(expected_day) AS expected_day
  FROM probe GROUP BY dim, cal_market
),
-- ── 白名单驱动的两个 us 标的级维度（`us_equity_bar` / `underlying_iv_daily`）─────────────
-- 工作集同源 = `need_sync` 白名单（个位数、且每只都是 045 雷达锚定标的）⇒ **只扫一遍
-- instrument**，两张事实表各出一列 `*_fresh`。判定语义**相反**（bar = OR / iv = AND），
-- 完整理由见文件头「覆盖边界」，改之前先读那段。
us_expected AS (
  SELECT (SELECT c.date FROM cal c WHERE c.market = 'us' AND c.rn = 3) AS expected_day  -- lag 2
),
us_probe AS (
  SELECT i.code,
         EXISTS (SELECT 1 FROM marketdata.daily_bar b
                 WHERE b.instrument_id = i.id
                   AND b.trade_date >= (SELECT expected_day FROM us_expected)) AS bar_fresh,
         EXISTS (SELECT 1 FROM marketdata.underlying_iv_daily v
                 WHERE v.instrument_id = i.id
                   AND v.date >= (SELECT expected_day FROM us_expected)) AS iv_fresh
  FROM marketdata.instrument i
  WHERE i.market = 'us' AND i.need_sync
),
us_verdict AS (
  SELECT count(*) AS workset,
         count(*) FILTER (WHERE bar_fresh) AS bar_fresh_cnt,
         count(*) FILTER (WHERE iv_fresh) AS iv_fresh_cnt,
         -- OR：任一只掉队即红；空工作集本身也是要抓的签名，故显式并上 `count(*) = 0`。
         (count(*) = 0 OR count(*) FILTER (WHERE NOT bar_fresh) > 0) AS bar_unhealthy,
         -- AND：全部陈旧才红。**空工作集无需另写分支** —— 工作集为 0 时 fresh 计数天然为 0，
         -- 判红已经成立；多写一个 `count(*) = 0 OR` 只是给自己留一处会与上面那条漂移的地方。
         count(*) FILTER (WHERE iv_fresh) = 0 AS iv_unhealthy,
         (SELECT expected_day FROM us_expected) AS expected_day
  FROM us_probe
),
-- ── 指数级维度 `us_index_daily`（VIX / VVIX）──────────────────────────────────────────────
-- 🚨 **形态与上面两个不同，别照抄**：本表无 `instrument` 关联（富途与东财均不收录这两个代码
--    ⇒ 库里根本不存在对应的 Instrument 行），工作集 = **两个固定代码常量**、与锚闸无关
--    （046 FR-027）。写成「查 instrument」会让它恒空恒红。
-- 取 **OR**：两个代码都是常量、每交易日都必然有值，不存在「正常缺席」这回事 ⇒ 缺一个就是真
-- 故障。表整个空 / 只有一个代码在长，都会落到 fresh_cnt < 2 判红（沉默 ≠ 健康）。
watched_index(index_code) AS (
  VALUES ('VIX'), ('VVIX')
),
idx_probe AS (
  SELECT EXISTS (SELECT 1 FROM marketdata.us_index_daily x
                 WHERE x.index_code = w.index_code
                   AND x.date >= (SELECT expected_day FROM us_expected)) AS has_fresh
  FROM watched_index w
),
idx_verdict AS (
  SELECT count(*) AS codes,
         count(*) FILTER (WHERE has_fresh) AS fresh_cnt,
         count(*) FILTER (WHERE NOT has_fresh) > 0 AS unhealthy,
         (SELECT expected_day FROM us_expected) AS expected_day
  FROM idx_probe
),
-- ── 047 M2b：期权链两个标的级维度 ────────────────────────────────────────────────────────
-- 工作集 = `need_sync` 锚里**已经有合约的那些**（见文件头「047 M2b 三个新维度」段）。
-- 一趟扫 instrument，三个 EXISTS 各走 (underlying_instrument_id, …) 前导索引。
--
-- 🚨 **⑦ 与 ⑧ 的市场作用面蓄意不同，别顺手统一**（#262 交付面 ③ 盘点的产出）:
--   · ⑦ 到期阶梯 = **us + hk**。港股期权 2026-08-23 上线后这条一直是 us-only ⇒ 港股的
--     「窗序列跑到一半 budget 耗尽、阶梯被截断」**零探针**。`marketdata-snapshot-integrity`
--     补不上这个洞: 它的分母取自基线日**已有的**合约集, 阶梯右端缺失它看不见 (那个文件头
--     写的「两个探针分工」反过来同样成立)。空工作集同理 —— 它判「无对象」不告警。
--   · ⑧ 快照数据年龄 = **仍只判 us**。港股快照停摆已由 08:00 完整性探针**日频**覆盖
--     (#267 市场通用, 分母为 0 即红) ⇒ 扩到 4h 只把检出从 ~24h 缩到 ~4h, 却要为 hk 另立
--     一个 lag 常量 (港股夜链当日 23:00 收口, 与 us 的 lag 2 不同源)。性价比不成立。
--     🚫 将来若真要扩, **先实测 hk 的 lag**, 别照抄 `us_expected`。
--   · 120d 阈值对 hk **实测有余量**, 无需另立: 2026-08-29 prod 实测两只 hk 锚的阶梯右端
--     均为 2027-06-29 (**304 天 / 8 个到期日**), 而 us 锚是 174–265 天。
opt_probe AS (
  SELECT i.market, i.code,
         EXISTS (SELECT 1 FROM marketdata.option_contract c
                 WHERE c.underlying_instrument_id = i.id) AS has_contracts,
         -- ⑦ 前向到期阶梯右端（120d，理由见文件头；🚫 别改成 updated_at，稳态零写入）。
         EXISTS (SELECT 1 FROM marketdata.option_contract c
                 WHERE c.underlying_instrument_id = i.id
                   AND c.expiry_date >= (SELECT d FROM today) + 120) AS ladder_ok,
         -- ⑧ 快照数据年龄（lag 2，与 us_equity_bar 共用 us_expected）。
         EXISTS (SELECT 1 FROM marketdata.option_daily_snapshot s
                 JOIN marketdata.option_contract c ON c.id = s.contract_id
                 WHERE c.underlying_instrument_id = i.id
                   AND s.session_date >= (SELECT expected_day FROM us_expected)) AS snapshot_fresh
  FROM marketdata.instrument i
  WHERE i.market IN ('us', 'hk') AND i.need_sync
),
-- ⑦ **逐市场**判定。🚨 由固定市场清单 LEFT JOIN 驱动（同文件头「沉默 ≠ 健康」那条）——
--    某市场的锚整个消失时仍必须出一行判红，而不是因为 GROUP BY 没有该组就静默放行。
-- 🚨 **必须按 market 分组，不能只按整体聚合**：一个市场的锚整体挂掉会被另一个市场的健康值
--    平均掉判绿 —— 同 `dim_verdict` 那条教训（044 探针的「不被健康市场平均掉」）。
opt_markets(market) AS (VALUES ('us'), ('hk')),
ladder_verdict AS (
  SELECT m.market,
         count(p.code) FILTER (WHERE p.has_contracts) AS workset,
         count(p.code) FILTER (WHERE p.has_contracts AND p.ladder_ok) AS ok_cnt,
         -- 空工作集（该市场一只锚都没有合约）本身是要抓的签名 → 判红，同 us_equity_bar。
         -- ⚠️ 推论：**装机时序**同文件头那条 —— 先确认链发现在 prod 跑出过一轮，再装本谓词。
         (count(p.code) FILTER (WHERE p.has_contracts) = 0
          OR count(p.code) FILTER (WHERE p.has_contracts AND NOT p.ladder_ok) > 0) AS unhealthy
  FROM opt_markets m
  LEFT JOIN opt_probe p ON p.market = m.market
  GROUP BY m.market
),
-- ⑧ 仍只判 us（理由见上方 🚨 段）。工作集与 expected_day 均沿用原口径，逐点不变。
opt_verdict AS (
  SELECT count(*) FILTER (WHERE has_contracts) AS workset,
         count(*) FILTER (WHERE has_contracts AND snapshot_fresh) AS snapshot_fresh_cnt,
         (count(*) FILTER (WHERE has_contracts) = 0
          OR count(*) FILTER (WHERE has_contracts AND NOT snapshot_fresh) > 0) AS snapshot_unhealthy,
         (SELECT expected_day FROM us_expected) AS expected_day
  FROM opt_probe WHERE market = 'us'
),
-- ── #179：HK 合约词根 ∩ 美股标的代码（vendor 按词根串市场的**前提条件**）─────────────────
-- 富途在美股方向按**词根**解析标的、忽略市场前缀 ⇒ 请求 `US.<root>` 会掺回同词根的 HK 合约
-- （2026-08-25 实测：`US.ALB` 136 行里 56 行属 `HK.09988` —— 阿里港股的交易所助记符恰好也是
-- `ALB`）。链 adapter 已按 owner 市场把它们丢掉，所以**撞名本身不是故障**。
--
-- 🚫 **别把它接进 `bad`**：撞名一旦存在就长期存在（`ALB` 自 066 接入港股锚起就在），接进去
--    = 永久假红，正是文件头那条「稀疏事件流硬塞进来只会制造长期噪音」。这里**只报数**，
--    要看的是**这个数什么时候变**（每加一只港股锚都可能长出新撞名，而人维护的清单会失效）。
root_collision AS (
  SELECT count(DISTINCT c.root) AS n,
         coalesce(string_agg(DISTINCT c.root, ',' ORDER BY c.root), '') AS roots
  FROM marketdata.option_contract c
  WHERE c.market = 'hk'
    AND EXISTS (SELECT 1 FROM marketdata.instrument i
                WHERE i.market = 'us' AND i.code = c.root)
),
-- ── #199：跨市场幽灵合约（**判红** —— 与上面那条方向刚好相反，别混）───────────────────────
-- 判据 = 同一个**合约标识**（code 去掉市场前缀那一段 = `root+到期+方向+行权价`）同时挂在一个
-- **us** 标的和一个 **hk** 标的名下。
--
-- 🚨 **它和「词根撞名」不是同一件事，所以判红方向也相反**：
--   · 词根撞名 = `root` 这一层的巧合，**长期存在、不是故障** ⇒ 上面那条只报数。
--   · 本条 = **合约行**这一层的重合（到期日 / 方向 / 行权价全都一样）。vendor 侧一个合约标识
--     只属于一个市场 —— 2026-08-27 实测 `US.ALB260828C100000` 在 vendor 那里**根本不存在**
--     （打快照直接「未知股票」），而同后缀的 `HK.ALB260828C100000` 是真的 ⇒ 两边同时有行，
--     其中一边必然是**脏行**。
--
-- ═══ 它抓的是什么形态（2026-08-22 prod 真事，别当假设）═══
-- vendor 在美股方向按词根解析标的时，**有一种自洽形态**：把阿里港股的整条期权阶梯用
-- `code=US.ALB…` + `stock_owner=US.ALB` 返回。#179 的跨市场 filter（按 owner 市场丢行）和
-- `sync-option-contract` 的护城河（owner ≠ 请求标的则 throw）**两道都看不见它** —— 它没有任何
-- 一处自相矛盾。于是 146 行幽灵合约落进 us:ALB 名下，此后每晚快照第一批必 502、整票零采，
-- 而 502 在当时只显形为一个光秃秃的状态码 ⇒ 三轮无人被叫醒。
-- ⇒ **本条是目前唯一能抓到「自洽形态」的判据**，别因为「#179 已经修了」就把它删掉。
--
-- ⚠️ **理论假阳性**：若哪天真出现「美股某票的 root 撞上港股某 root，且同一到期日 + 同方向 +
--    同行权价」的合法重合，本条会红。蓄意接受 —— 那个组合罕见到本来就该有人看一眼再判，而它的
--    反面（幽灵行静默常驻）已经真实发生过一次，代价是该票**每晚整票零采**。
--
-- 🚨 判据与一次性清理 migration `20260827_1457_delete_cross_market_ghost_option_contracts`
--    **同口径**（那条删的正是本条数出来的行）。改一处必须改另一处，否则表现是「清理跑完探针
--    还红」或反过来「探针绿而库里仍有脏行」。
--
-- 性能：`option_contract` 是万行量级（prod 2026-08-10 实测 7620 行），两侧各一次 seq scan +
-- 表达式 hash semi join，毫秒级 —— 与文件头警告的 `volatility_daily`（1590 万行）不是一个量级。
hk_contract_suffix AS (
  SELECT DISTINCT substring(h.code FROM 4) AS suffix
  FROM marketdata.option_contract h
  JOIN marketdata.instrument hi ON hi.id = h.underlying_instrument_id
  WHERE h.market = 'hk' AND hi.market = 'hk'
),
ghost_contract AS (
  SELECT count(*) AS n,
         coalesce(string_agg(DISTINCT g.symbol, ',' ORDER BY g.symbol), '') AS symbols
  FROM (
    SELECT i.market || ':' || i.code AS symbol
    FROM marketdata.option_contract c
    JOIN marketdata.instrument i ON i.id = c.underlying_instrument_id
    WHERE c.market = 'us' AND i.market = 'us'
      AND substring(c.code FROM 4) IN (SELECT suffix FROM hk_contract_suffix)
  ) g
),
-- ── 047 M2b：财报日历（市场级，无逐票工作集）────────────────────────────────────────────
-- 两条信号并联，理由见文件头。max() 各走 ix_earnings_event_date / 全表（表小，见下注）。
-- ⚠️ `first_seen_at` 无索引 ⇒ max() 是 seq scan；该表 2–8 万行/年、逐年累积，量级远低于
--    volatility_daily 的 1590 万行，每 4h 一次可接受。日后若表长到百万级，加 (first_seen_at) 索引。
earn_probe AS (
  SELECT (SELECT max(e.earnings_date) FROM marketdata.earnings_event e) AS horizon_day,
         (SELECT max(e.first_seen_at) FROM marketdata.earnings_event e) AS last_seen_at,
         (SELECT c.date FROM cal c WHERE c.market = 'us' AND c.rn = 6) AS seen_expected_day
),
earn_verdict AS (
  SELECT p.horizon_day, p.last_seen_at, p.seen_expected_day,
         -- 表整个空 / 日历算不出 expected → 判红（沉默 ≠ 健康）。
         (p.horizon_day IS NULL
          OR p.last_seen_at IS NULL
          OR p.seen_expected_day IS NULL
          OR p.horizon_day < (SELECT d FROM today) + 120
          OR (p.last_seen_at AT TIME ZONE 'Asia/Shanghai')::date < p.seen_expected_day) AS unhealthy
  FROM earn_probe p
),
-- ── 047 M2b：磁盘水位（FR-052a，唯一入参 :avail_kb）────────────────────────────────────
disk_probe AS (
  SELECT (SELECT min(s.session_date) FROM marketdata.option_daily_snapshot s) AS first_day,
         (SELECT max(s.session_date) FROM marketdata.option_daily_snapshot s) AS last_day,
         pg_total_relation_size('marketdata.option_daily_snapshot')
           + pg_total_relation_size('marketdata.option_contract')
           + pg_total_relation_size('marketdata.earnings_event') AS bytes_047,
         (:avail_kb)::bigint * 1024 AS avail_bytes
),
disk_measured AS (
  SELECT p.bytes_047, p.avail_bytes,
         -- 交易日数从**日历**数（小表），别在 6.4M 行/年 的快照表上 count(DISTINCT)。
         coalesce((SELECT count(*) FROM marketdata.trading_day t
                   WHERE t.market = 'us' AND t.date BETWEEN p.first_day AND p.last_day), 0)
           AS session_days
  FROM disk_probe p
),
disk_verdict AS (
  SELECT m.session_days,
         -- 样本不足 10 个交易日 → 不可算（上线首两周的正常空态），NULL 而非 0（0 会长得像
         -- 「零增长」= 永远撑得住，恰好方向相反的误读）。
         CASE WHEN m.session_days >= 10 THEN m.bytes_047 / m.session_days END AS daily_growth_bytes,
         CASE WHEN m.session_days >= 10
              THEN m.avail_bytes / greatest(m.bytes_047 / m.session_days, 1) END AS runway_days,
         (m.session_days >= 10
          AND m.avail_bytes < (m.bytes_047 / m.session_days) * 90) AS unhealthy
  FROM disk_measured m
),
-- ── #262：OI 归属标签一致性（判据 ⑫，**市场通用**；论证见文件头该段）───────────────────
-- `settle_min` 为 NULL 的市场 = 「不在收盘当晚定稿」⇒ `eod` 路径恒退到上一交易日（us 现役 45.7
-- 万行走的就是这一档）。hk 登记 21:30。**本表与 `MARKET_OI_SETTLE_LOCAL_MINUTE` 必须同值。**
oi_zone(market, zone, settle_min) AS (
  VALUES ('hk', 'Asia/Hong_Kong', 21 * 60 + 30),
         ('us', 'America/New_York', NULL::int)
),
-- 近期每个交易日 → 它的上一交易日。rn 升序 = 日期降序 ⇒ `lead()` 恰是「更早那一个」。
-- 取 4 档：前 3 档是可判 session，第 4 档只作为第 3 档的前驱。🚨 MATERIALIZED 不可摘（见文件头）。
oi_prev AS MATERIALIZED (
  SELECT market, date AS session_date, rn,
         lead(date) OVER (PARTITION BY market ORDER BY rn) AS prev_td
  FROM cal WHERE rn <= 4
),
oi_probe AS (
  SELECT c.market, s.session_date, s.oi_as_of, s.source, p.prev_td, z.settle_min,
         (s.quote_as_of AT TIME ZONE z.zone)        AS local_ts,
         (s.quote_as_of AT TIME ZONE z.zone)::date  AS local_date,
         -- ⑬ 带内零哨兵（ADR-0067）。**蓄意折进本趟扫描**: 与 ⑫ 同表、同窗口、同 JOIN,
         -- 单独再扫一遍就是白付一次 28 万行的代价。判据与采集端 `normalizeQuoteSide` /
         -- `tradedPriceOrNull` 逐字同构 —— 🚨 盘口价**必须成对判**（OPRA 明写零价可以是合法
         -- 报价, 只看价格会静默吃掉真实的零价买盘）; 成交价类**允许单列判**（富途书面确认
         -- 「期权成交价恒为正值, 返回的 0 一律表示无最后成交价」, #258)。
         CASE WHEN s.bid = 0 AND s.bid_size = 0 THEN 'bid'
              WHEN s.ask = 0 AND s.ask_size = 0 THEN 'ask'
              WHEN s.last = 0                   THEN 'last'
              WHEN s.prev_close = 0             THEN 'prev_close'
              WHEN s.underlying_spot = 0        THEN 'underlying_spot' END AS sentinel_col
  FROM marketdata.option_daily_snapshot s
  JOIN marketdata.option_contract c ON c.id = s.contract_id
  JOIN oi_zone z ON z.market = c.market
  JOIN oi_prev p ON p.market = c.market AND p.session_date = s.session_date AND p.rn <= 3
  WHERE s.session_date >= (SELECT min(session_date) FROM oi_prev WHERE rn <= 3)
),
-- 应然值 = 写路径 (`sync-option-snapshot.usecase.ts` 的 `oiFinalizedAtSessionClose`) 的 SQL 复刻：
--   非 eod（盘前补采）        ⇒ 恒 session_date（已跨进下一场的盘前，OI 必已翻新）
--   该市场不在当晚定稿        ⇒ 上一交易日（us）
--   采集日 ≠ session 日       ⇒ 更晚即已定稿 → session_date；更早（不该出现）→ 上一交易日
--   同日且已过定稿时刻        ⇒ session_date，否则上一交易日
oi_verdict AS (
  SELECT count(*) AS judged,
         count(*) FILTER (WHERE NOT ok) AS bad_rows,
         count(*) FILTER (WHERE NOT ok) > 0 AS unhealthy,
         coalesce(string_agg(DISTINCT tag, ',' ORDER BY tag) FILTER (WHERE NOT ok), '') AS tags
  FROM (
    SELECT market || ':' || session_date || '/' || source AS tag,
           oi_as_of IS NOT DISTINCT FROM (CASE
             WHEN source <> 'eod' THEN session_date
             WHEN settle_min IS NULL THEN prev_td
             WHEN local_date <> session_date
               THEN CASE WHEN local_date > session_date THEN session_date ELSE prev_td END
             WHEN extract(hour FROM local_ts) * 60 + extract(minute FROM local_ts) >= settle_min
               THEN session_date
             ELSE prev_td END) AS ok
    FROM oi_probe
  ) g
),
-- ⑬ 判定面与 ⑫ 完全相同（同一 `oi_probe`）⇒ 覆盖边界也相同: 窗口外的旧行不判。
-- `string_agg` 天然跳过 NULL ⇒ 干净行不进 `cols`, 无需再加 FILTER。
sentinel_verdict AS (
  SELECT count(*) FILTER (WHERE sentinel_col IS NOT NULL) AS n,
         coalesce(string_agg(DISTINCT sentinel_col, ',' ORDER BY sentinel_col), '') AS cols
  FROM oi_probe
),
bad AS (
  SELECT (SELECT count(*) FROM dim_verdict WHERE unhealthy)
       + (SELECT count(*) FROM us_verdict WHERE bar_unhealthy)
       + (SELECT count(*) FROM us_verdict WHERE iv_unhealthy)
       + (SELECT count(*) FROM idx_verdict WHERE unhealthy)
       + (SELECT count(*) FROM ladder_verdict WHERE unhealthy)
       + (SELECT count(*) FROM opt_verdict WHERE snapshot_unhealthy)
       + (SELECT count(*) FROM earn_verdict WHERE unhealthy)
       + (SELECT count(*) FROM disk_verdict WHERE unhealthy)
       + (SELECT count(*) FROM ghost_contract WHERE n > 0)
       + (SELECT count(*) FROM oi_verdict WHERE unhealthy)
       + (SELECT count(*) FROM sentinel_verdict WHERE n > 0) AS n
)
SELECT
  ((SELECT n FROM bad) > 0)::int AS exit_code,
  CASE WHEN (SELECT n FROM bad) > 0 THEN '🔴 marketdata 表级数据不健康' ELSE '✅ marketdata 表级数据健康' END
  || ' (判据 = 哨兵票数据年龄按交易日折算): '
  || (SELECT string_agg(
         scope || '=' || fresh_cnt || '/' || sentinels
         || coalesce('@' || expected_day::text, '@日历缺失')
         || CASE WHEN unhealthy THEN '⚠陈旧' ELSE '' END,
         ' | ' ORDER BY scope)
      FROM dim_verdict)
  || ' | us_equity_bar=' || (SELECT bar_fresh_cnt || '/' || workset FROM us_verdict)
  || coalesce('@' || (SELECT expected_day::text FROM us_verdict), '@日历缺失')
  || CASE WHEN (SELECT bar_unhealthy FROM us_verdict) THEN '⚠掉队' ELSE '' END
  -- 标记词区分语义，别统一：`⚠掉队` = OR（有票掉队）· `⚠陈旧` = AND（整维停摆）· `⚠缺数` = 指数缺代码。
  || ' | underlying_iv_daily=' || (SELECT iv_fresh_cnt || '/' || workset FROM us_verdict)
  || coalesce('@' || (SELECT expected_day::text FROM us_verdict), '@日历缺失')
  || CASE WHEN (SELECT iv_unhealthy FROM us_verdict) THEN '⚠陈旧' ELSE '' END
  || ' | us_index_daily=' || (SELECT fresh_cnt || '/' || codes FROM idx_verdict)
  || coalesce('@' || (SELECT expected_day::text FROM idx_verdict), '@日历缺失')
  || CASE WHEN (SELECT unhealthy FROM idx_verdict) THEN '⚠缺数' ELSE '' END
  -- 047 M2b 四条。`⚠阶梯截断` = 到期阶梯右端不足 120d · `⚠视野` = 财报前向视野塌陷或停止观察
  -- · `⚠水位` = 可撑天数不足 90d（标记词各自专属，别与上面的 ⚠陈旧/⚠掉队/⚠缺数 混用）。
  -- ⑦ 逐市场报数（`us:N/M,hk:N/M`）—— 只报总数会让「某个市场整体挂掉」看不出是哪一个。
  || ' | option_contract='
  || (SELECT string_agg(market || ':' || ok_cnt || '/' || workset, ',' ORDER BY market)
      FROM ladder_verdict) || '@≥+120d'
  || CASE WHEN (SELECT bool_or(unhealthy) FROM ladder_verdict) THEN '⚠阶梯截断' ELSE '' END
  || ' | option_daily_snapshot=' || (SELECT snapshot_fresh_cnt || '/' || workset FROM opt_verdict)
  || coalesce('@' || (SELECT expected_day::text FROM opt_verdict), '@日历缺失')
  || CASE WHEN (SELECT snapshot_unhealthy FROM opt_verdict) THEN '⚠掉队' ELSE '' END
  || ' | earnings_event=视野'
  || coalesce((SELECT horizon_day::text FROM earn_verdict), '空表')
  || '/新观察' || coalesce((SELECT (last_seen_at AT TIME ZONE 'Asia/Shanghai')::date::text
                            FROM earn_verdict), '无')
  || CASE WHEN (SELECT unhealthy FROM earn_verdict) THEN '⚠视野' ELSE '' END
  || ' | disk='
  || coalesce((SELECT '可撑' || runway_days || 'd(日均' || daily_growth_bytes || 'B)'
               FROM disk_verdict),
              (SELECT '样本不足(' || session_days || '/10 交易日)' FROM disk_verdict))
  || CASE WHEN (SELECT unhealthy FROM disk_verdict) THEN '⚠水位' ELSE '' END
  -- #179 词根撞名：**报数不判红**（理由见上面 root_collision 那段的 🚫）。无撞名时不带括号。
  || ' | root撞名=' || (SELECT n FROM root_collision)
  || coalesce('(' || nullif((SELECT roots FROM root_collision), '') || ')', '')
  -- #199 跨市场幽灵合约：**判红**。`⚠跨市场` 是本条专属标记词，别与上面几个混用。
  || ' | 幽灵合约=' || (SELECT n FROM ghost_contract)
  || coalesce('(' || nullif((SELECT symbols FROM ghost_contract), '') || ')', '')
  || CASE WHEN (SELECT n FROM ghost_contract) > 0 THEN '⚠跨市场' ELSE '' END
  -- #262 OI 归属标签：**判红**。`⚠OI标签` 是本条专属标记词。分母 = 窗口内被判定的行数，
  -- 分子 = 标签不符的行数；括号里是 `市场:session/source` 三元组（定位到是哪一轮写的）。
  || ' | oi归属=' || (SELECT bad_rows || '/' || judged FROM oi_verdict)
  || coalesce('(' || nullif((SELECT tags FROM oi_verdict), '') || ')', '')
  || CASE WHEN (SELECT unhealthy FROM oi_verdict) THEN '⚠OI标签' ELSE '' END
  -- ⑬ 零哨兵残留：**判红**。`⚠哨兵残留` 是本条专属标记词；括号里是命中的列名（定位到是
  -- 哪一类哨兵漏了归一化，盘口 / 成交价两类的修法不同）。
  || ' | 零哨兵=' || (SELECT n FROM sentinel_verdict)
  || coalesce('(' || nullif((SELECT cols FROM sentinel_verdict), '') || ')', '')
  || CASE WHEN (SELECT n FROM sentinel_verdict) > 0 THEN '⚠哨兵残留' ELSE '' END
  AS summary;
