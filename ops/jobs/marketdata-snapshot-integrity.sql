-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 期权快照**逐合约完整性**谓词 —— 047 T025a（FR-045 / FR-046 / FR-051）。
-- 范式逐条照抄 `ops/jobs/marketdata-table-health.sql`（**单一共享产物 / 唯一判断所在地**）。
--
-- 🚨🚨 这个文件是宪法 §II 合规的承重墙，动它前先读完本段。
--
-- 仓内无 bash 测试框架 → `marketdata-snapshot-integrity.sh` 无法 RED-first。沿用 044 / 表级探针的裁决 = **把 bash 压到
-- 零逻辑**：所有判断下沉到本谓词，bash 只剩「跑它 → `exit $exit_code` → 打印 summary」。
--   ⇒ 消费方**一律读本文件**，**禁止**在 bash / IT / 任何地方内联复制一份 SQL（两份必 drift）。
--
-- 已知消费方：
--   · `apps/server/test/integration/marketdata.snapshot-integrity.it.spec.ts`（**真测本文件**，
--     并把本文件的判定与 TS 侧 `option-snapshot-coverage.check.ts` 的判定**逐票钉在一起**）
--   · `ops/jobs/marketdata-snapshot-integrity.sh`（独立探针，每日采集窗结束后一跑）
--
-- **自包含 / 无参数**。契约（bash 零逻辑的前提，由 IT 断言锁死）：恒返 **单行两列**
-- `exit_code` `summary`；`exit_code ∈ {0,1}` 直接就是退出码；`summary` 单行、无 tab/换行。
--
-- ═══ 它为什么必须独立存在（而不是「T021 已经判过了」）═══
--
-- FR-046 明写「完整性 ERROR 的触达 **MUST NOT 并入次日日报**」。次日日报 = 次晨 09:00 的
-- `ops/jobs/marketdata-sync-report.sh` 读 `sync_run` 推飞书 —— 那条路径有两个致命面：
--   ① **晚一天**：昨天的缺口今早才有人知道，而期权快照**漏采即永久缺口**（vendor 不提供历史
--      交易日的期权快照），中间那一整天什么都补不回来；
--   ② **app 挂了就一起没了**：T021 的判定跑在采集进程内，结论落 log / `SyncRun`。app 整个挂掉
--      时数据自然缺失，而**判定本身也没跑**⇒ 最需要告警的那种故障恰好是最静默的一种（044 病灶形状）。
-- ⇒ 本谓词**直读 PG、不经 app 进程**，由独立 timer 在当晚采集窗结束后触发（FR-051）。
--
-- 🚨 **已知代价：同一判据两处实现**（TS 侧 `option-snapshot-coverage.check.ts` + 本文件）。
--    两侧要的东西不同（那侧要逐票明细 + 可注入故障的单测并驱动两级补救；本侧要独立于采集进程），
--    合并不掉。⇒ **判据必须同源**，由上面那个 IT 拿同一批人造数据把两边的逐票结论钉死。
--    改本文件 = 必须同时改那侧，否则 IT 当场红。
--
-- ═══ 判据（**任一票跌破阈值即 exit 1**）═══
--   分母 = **基线日**快照里、**到期日 ≥ 当日交易日**的合约集（按 contract_id 去重）
--   分子 = 其中**当日**实得快照的合约数
--   逐**标的**分组判定：`covered < expected × 阈值`（乘法不除法 —— 阈值 = 1 时退化成精确比较，
--   不吃浮点误差）。**MUST NOT 只看全局总数**：实测 PEP 730 行 / VICI 48 行，一只小票整票消失
--   落在全局比值的噪声里（778 → 730 = 93.8%，任何合理的全局阈值都判绿）。
--
-- ═══ 两层，期望源不同，**别揉在一起**（#231）═══
--   | 层 | 问的问题 | 期望源 | 归谁 |
--   | --- | --- | --- | --- |
--   | 存在性 | 这只票今天**完全没有行**吗？ | **名册**（`need_sync` 工作集 ∧ 有未到期合约） | 本谓词的 `absent` CTE |
--   | 完整性 | 今天**有行**的票，逐合约覆盖率够吗？ | 基线日快照 | 本谓词的 `per_underlying` |
--
-- 🚨 **与 `marketdata-table-health.sql` 判据 ⑧ 的分工（改任一侧前先读这段）**：⑧ 问的是
--    「有合约的 us 锚**任一只**拿不到新快照」，逐票、无基线、**lag 2 交易日**。它抓「整票**长期**
--    消失」；本谓词抓「**当日**的缺席与逐合约缺口」。⇒ 两者互补不重叠：
--      · 只有 ⑧ ⇒ 「某票少了 48 张合约」永远看不见（⑧ 只要有一行就算新鲜）；
--      · 只有本谓词 ⇒ 缺口超出当日视野后无人接管。
--    🚫 **MUST NOT 在本谓词里重造 ⑧**（把窗口拉宽去追长期缺席）：2026-08-27 prod 实测，分母
--    拉到 21 自然日窗要多付 **2.4× 耗时 + 342k buffers（≈2.7 GB）**，而买到的信息**只有缺席
--    那一只票** —— 而那只票用名册一次索引扫就抓到了。
--
-- 🚨 **分母的到期判据是 `>=` 不是 `>`**（Guardrail 7）：当日到期的合约**当日仍可取快照**
--    （官方「结束日期请输入今天或未来的日期」），而那是这批腿**最后一次**可采的机会。写成 `>`
--    只在到期日当天整批放行，平时看不出来。⚠️ 选约表那侧（T027）是 `>`（已到期腿不可交易）——
--    **两处判据故意不同，别统一**。
--
-- 🚨 **基线日 = 有快照行的最近一个更早 `session_date`**，不是日历上的上一交易日。
--    取日历日而那天恰好也整体停摆 ⇒ 分母为空 ⇒ 判「无对象」⇒ **连续停摆自我掩盖**。取「最近
--    有数据的那天」则缺口一直挂着直到补回来。跨假期的陈旧基线不会造成假红：`到期日 ≥ 当日`
--    已把期间到期的腿滤掉。
--
-- 🚫 **MUST NOT 用交易日历打「今天是大到期日所以放宽」的补丁**（循环信任，044 同款）。假阳性
--    由**分母口径**解决 —— 已到期的腿本就不进分母，大到期日次日分母自然缩小，无需任何日期特判。
--
-- **分母为空 = 「无对象」，不是 0%** —— 零锚 / 首日 / 基线日合约当日全部到期，判 0% 会让这些
-- 正常空态天天红。⇒ exit 0，且 summary 显式写「无对象」（不静默）。
--
-- ⚠️ **代价：非交易日跑会假红**（当日本就无快照）。timer 是 `*-*-* 08:00` **每日**跑，所以这个
--    代价是真会兑现的，而且是**每周两条**不是一条：北京周日早 = ET 周六，北京周一早 = ET 周日
--    （~104 条/年）。⇒ 本谓词自带一道**周末闸**（下面 `bounds.is_weekend`）：该市场的当日落在
--    周六 / 周日 ⇒ exit 0，且 summary 显式写明「不判」（**不静默**）。逐市场各判各的。
--
-- 🚨 **周末闸与上面那条「MUST NOT 用交易日历」不是一类东西，别把它当成破例**：
--    那条禁的是**查 `trading_day` 表**来放宽 / 跳过判定 —— 那张表正是采集管线交易日闸读的同一张，
--    日历一坏 ⇒ 采集跳过真交易日 ⇒ 谓词跟着闭嘴，**恰好瞎在最该告警的地方**（044 病灶形状）。
--    而周末闸是 `isodow` **纯日期算术，不读任何表、不依赖任何被监控对象**：周六周日对本谓词
--    服务的两个市场都不是交易日，那两天根本不存在「本该有快照却没有」这个状态 ⇒ 消掉它
--    **零检测力损失**。
--
-- 🚨 **美股节假日曾经会假红（~9-10 次/年），2026-08-28 已修（#276）**。此处原文写的是
--    「蓄意保留，别顺手把它也修了」，理由是「要消掉它就必须查 `trading_day`，那就踩进循环信任」。
--    **那个二选一是假的**：踩陷阱的是「查日历 → 静默放行」，而三态判据在**放行前要求日历正向
--    声明它覆盖了今天**，日历陈旧时落 `unknown` ⇒ **判红**。极性相反，不是同一件事。
--    判据与逐条语义见下方 `calendar` CTE 上方那段。实证：注入 `2026-09-07`（劳动节）修前
--    `exit 1` + 106 票全 `0/N⚠缺`，修后 `exit 0`「非交易日不判」。
--
-- ═══ 当日 = **该市场的今天**，不是宿主的今天（逐市场取，见下方 `markets` CTE）═══
-- `session_date` 是按各市场时区求值的业务日（FR-036）。timer 跑在北京 08:00：
--   · us = ET 前一日 19:00/20:00 ⇒ `ET 当日` 正是刚采完的那一场（offset 0）；
--   · hk = HKT 当日 08:00，而港股夜链在 **HKT 次日 00:33–00:36** 才采上一场 ⇒ 取 `HKT 当日 − 1`。
-- 用 `Asia/Shanghai` 或对两个市场共用一个日期，都会**恒偏一天**、每天整批假红。
--
-- 🚨 **「当日」可注入，且注入点只为可测性存在**：`current_setting('nvy.current_day', true)` 非空
--    时覆盖它。**生产从不设这个 GUC** —— `.sh` 不传 `-v`、不设任何 SET ⇒ 恒走 `now()` 那支。
--    它存在的唯一理由：周末闸的判据是「今天星期几」，不可注入就只能靠「等到周六再跑一次 IT」来
--    验 = 等于没验，而未被真测的判断正是宪法 §II 要堵的洞。IT 用 `SET LOCAL` 在事务内钉死日期，
--    并另留一条**不注入**的用例守住上面那条 ET 时区判据（否则改成 Asia/Shanghai 也没人发现）。
--    ⚠️ 它同时是个**静音开关**：谁要是 `ALTER DATABASE … SET nvy.current_day`，探针会天天核对
--    同一个历史日、永远绿。别这么干，也别把它接进任何 env / 配置文件。
--
-- ═══ 🚨 市场维：**每一处取数都必须带 market**，而且带的是**标的**那一列 ═══
-- #255：港股期权 2026-08-23 接入后，本文件的 baseline / denom / collected / present 四处曾是裸的
-- （只有 `roster` 带 `i.market = 'us'`）⇒ 港股合约混进美股分母。app 侧同一缺陷把港股票交给了
-- 美股补救器，按美股语义写库、1110 行 `oi_as_of` 差一天。⇒ **漏一处就是一次跨市场污染**，
-- 而它不会红：分母悄悄变大 / 变小，逐票数字照样打得出来。
--
-- ✅ **#267：本谓词自 2026-08-28 起服务 us + hk 两个市场**（此前只有 us，港股在「app 挂了也
--    还在」这条独立通道上是一片空白，FR-051 对港股未兑现）。落法是**单文件市场通用**而不是
--    复制第二份：两市场的判据只差三个常量（market / 时区 / 日偏移），复制出来的第二份必 drift，
--    而 #255 正是「四处判据漏改一处」出的事。
--    📌 **没有第二条 timer**：北京 08:00 那一跑对港股同样成立 —— hk 的 `current_day` = HKT 当日
--    减一天，那一场在 HKT 00:33–00:36 就采完了，早 7 个多小时。
--    📌 TS 侧 `option-snapshot-coverage.check.ts` 的 `check(market, sessionDate)` 早已是市场
--    参数化的（#255 做的），本文件此前是落后的那一半；两侧现在同形，IT 那条「逐票结论一致」
--    的绊线也随之覆盖到 hk。
--
-- ═══ 性能 ═══
-- 两次以 `session_date` 为入口的查询，走 `ix_option_daily_snapshot_session_date`；合约按主键
-- join。**没有任何全表扫**（本表是全库增长最快的表，约 6.4M 行/年）。O(两日快照行数之和)。
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- ═══ 市场表：本谓词**唯一**的市场维（#267）═══
-- 🚨 这**不是**「传参」——`.sh` 仍不传任何东西，判断仍全在本文件里。文件头那条「自包含 / 无参数」
--    禁的是把判断挪回 bash，而一张写死在谓词内部的市场表恰恰相反：它把「服务哪些市场」也变成了
--    本文件的一部分，改市场 = 改本文件 = 走 IT。
--
-- 🚨 `day_offset` **不是凑数，两个市场的采集时刻结构不同**（2026-08-28 实测）：
--   · us：夜链在 ET 当日盘后跑完；timer 北京 08:00 = ET 前一日 19:00/20:00 ⇒ `ET 当日` 恰是
--     刚采完的那一场 ⇒ offset 0。
--   · hk：夜链 cron 写 23:00，但**实际执行落在次日 HKT 00:33–00:36**（run 834 = 08-28 00:36:46
--     采 session 08-27；799 / 775 同形）⇒ **任何「session D 已入库」的时刻，HKT 日期都 ≥ D+1**
--     ⇒ 照抄 `HKT 当日` 会每天判一个还没开盘的 session（实测该日恒 0 行 = 天天假红）⇒ offset −1。
--
-- 🚫 **MUST NOT 改成「取该市场最后一个已收盘交易日」** —— 那个取法实测会让周六 / 周日 / 周一
--    三天都指向同一个周五 session ⇒ **同一个缺口重复报三次**。`−1` + 三态闸则每个 session
--    恰好判一次（周六判周五、周日判周六→non-trading 不判、周一判周日→不判、周二判周一）。
WITH markets(market, tz, day_offset) AS (
  VALUES ('us', 'America/New_York', 0),
         ('hk', 'Asia/Hong_Kong', -1)
),
bounds AS (
  SELECT m.market,
         anchor.current_day,
         -- 周六(6) / 周日(7)：该市场不开盘 ⇒ 当日本就不存在快照，判它 = 每周两条假红（见文件头）。
         -- **纯 isodow 算术，不读任何表** —— 与被禁的「查交易日历放宽判定」不是一类。
         EXTRACT(isodow FROM anchor.current_day) >= 6 AS is_weekend
  FROM markets m
  CROSS JOIN LATERAL (
    SELECT coalesce(
             -- 仅测试注入（见文件头）；生产从不设此 GUC ⇒ 恒走下面那支。
             -- ⚠️ 注入时**对所有市场同时生效且不再加 offset** —— 注入的语义是「直接钉死 current_day」。
             --    ⇒ `day_offset` 只走生产那支 ⇒ 必须另有一条**不注入**的用例守它（同 ET 时区那条）。
             nullif(current_setting('nvy.current_day', true), '')::date,
             (now() AT TIME ZONE m.tz)::date + m.day_offset
           ) AS current_day
  ) anchor
),
-- ═══ 非交易日闸的**第二格**：公众假期（#276）═══
-- 上面那道 `isodow` 闸只挡周末。美股公众假期是**工作日** ⇒ 闸放行 ⇒ 当日零快照 ⇒ 存在性层判
-- 全票缺席 ⇒ 假红。2026-08-28 用本文件自己的 GUC 注入口对 prod 实测：注入 `2026-09-07`
-- （劳动节，周一）得 `exit 1` + 106 票全 `0/N⚠缺`；注入 `2026-09-05`（周六）与 `2026-08-27`
-- （真交易日）均如常。⇒ 假红是实证，不是推演。约 9–10 次/年。
--
-- 🚨 **判据 = `trading-day.rules.ts` 的三态 `classifyTradingDay`，🚫 MUST NOT 自己发明第四种读法。**
--   `check-trading-day-read.ts` 的文件头记着本仓犯过的那个病：把「无记录」读成「不是交易日」
--   （closed-world assumption）⇒ 那一行落库之前，所有消费方拿到**静默的**错误答案。语义逐条对齐：
--
--   | 条件                                                    | 状态          | 本闸处置              |
--   | ------------------------------------------------------- | ------------- | --------------------- |
--   | `trading_day` 有该行                                    | `trading`     | 正常判                |
--   | 无该行，**且**该日在 `calendar_coverage` 已声明区间内    | `non-trading` | exit 0「非交易日不判」 |
--   | 无该行，且在区间外 / 无声明                             | `unknown`     | **exit 1**，fail-closed |
--
-- 🚨 **这为什么不撞 FR-045 的循环信任**：被禁的形态是「查日历 → 静默放行」。这里放行需要日历
--   **正向声明**它覆盖了今天；日历陈旧 ⇒ 落 `unknown` ⇒ **判红**而不是判绿。
--   「日历坏了会让探针撒谎」被翻成「日历坏了会让探针响」——极性相反，不是同一件事。
--   ⚠️ `unknown` 也不会只有这一条通道看见：`calendar_coverage` 的活性另有独立探针每 4h 判
--   （`marketdata-calendar-health.sql` 判据 ③ 无声明 / ④ 视野落后 / ⑤ 视野过近）。
--
-- 🚨 **`is_weekend` 保留、不被三态取代**：它是纯算术、不读任何表 ⇒ 即使 `calendar_coverage`
--   整个坏掉，周末仍静默。周末在三态下同样得 `non-trading`，两者结论一致，isodow 只是更早短路。
--
-- 🚫 **已验过会错、别再走一遍**：「断言前瞻视野 ≥ N 天」**每年 12 月必假红** —— 前瞻段是
--   `[明天, 当年 12-31]`（`trading-calendar-sync.service.ts`），视野往年末逐日收缩。这件事
--   `marketdata-calendar-health.sql` 判据 ⑤ 早已处理（年末豁免 + 1 月 1 日起必红），且注释明写
--   「🚫 MUST NOT 加『1 月宽限期』」。⇒ 用 `calendar_coverage` 的**区间**语义，不造第二份视野判据。
calendar AS (
  -- 逐市场一行（与 `bounds` 同基数）。
  -- 🚨 区间判据是**闭区间两端**（`covered_from ≤ day ≤ covered_to`），与 `isWithinCoverage` 同形；
  --    只比 `covered_to` 会把「声明起点之前」误读成 non-trading。
  SELECT b.market,
    EXISTS (SELECT 1 FROM marketdata.trading_day t
            WHERE t.market = b.market AND t.date = b.current_day) AS has_row,
    EXISTS (SELECT 1 FROM marketdata.calendar_coverage c
            WHERE c.market = b.market
              AND b.current_day BETWEEN c.covered_from AND c.covered_to) AS within_coverage
  FROM bounds b
),
-- 🚨 **阈值的唯一所在地**（先验起手 1 = 100%，FR-045）。它与 TS 侧的
--    `MARKETDATA_OPTION_COVERAGE_THRESHOLD`（zod 默认 1）是**同一个口径的两处实现** ——
--    改一处必须改另一处，IT 里那条「9/10 覆盖」的用例就是拿来撞这个 drift 的。
config AS (
  SELECT 1::numeric AS coverage_threshold
),
-- 基线日 = 有快照行的、早于当日的最近一个交易日（见文件头）。全表无更早行 → NULL → 分母为空。
-- 🚨 #255：必须按市场取。取全表最近一天时，一个「us 休市、hk 开市」的日子会被选成基线
--    ⇒ 分母整个来自港股。2026-10-01 / 2026-10-19 就是这样的日子（us whole / hk 无行）。
-- 🚨 写成 `ORDER BY … DESC LIMIT 1` 而不是 `max()`：带 join 之后 `max()` 拿不到「索引倒序扫、
--    命中第一行就停」的形状，会退化成聚合全扫。本形状与 TS 侧 `findFirst(orderBy desc)` 同源。
baseline AS (
  SELECT b.market,
         (SELECT d.session_date
          FROM marketdata.option_daily_snapshot d
          JOIN marketdata.option_contract c ON c.id = d.contract_id
          JOIN marketdata.instrument i ON i.id = c.underlying_instrument_id
          WHERE d.session_date < b.current_day
            AND i.market = b.market
          ORDER BY d.session_date DESC
          LIMIT 1) AS baseline_day
  FROM bounds b
),
-- 分母：同一合约在基线日可能有 eod + premarket_backfill 两行 ⇒ **DISTINCT 去重**，否则靠兜底
-- 补采续命的那些票分母会凭空翻倍、覆盖率恒判红。
-- 🚨 #255：市场谓词钉在**标的**（`instrument.market`）而不是 `option_contract.market`。
--    本判据的单位是「票」，而两列可以不一致 —— #199 那批跨市场幽灵合约正是 `c.market='us'`
--    挂在港股标的名下，按合约列过滤会把它们放回美股分母。TS 侧 `option-snapshot-coverage.check.ts`
--    的四处查询用的是同一个谓词，**改一处必须改另一处**。
denom AS (
  SELECT DISTINCT b.market, d.contract_id, c.underlying_instrument_id
  FROM bounds b
  JOIN baseline bl ON bl.market = b.market
  JOIN marketdata.option_daily_snapshot d ON d.session_date = bl.baseline_day
  JOIN marketdata.option_contract c ON c.id = d.contract_id
  JOIN marketdata.instrument di ON di.id = c.underlying_instrument_id
  WHERE c.expiry_date >= b.current_day
    AND di.market = b.market
),
-- 分子：当日实得的合约集（同样多来源去重）。
collected AS (
  SELECT DISTINCT b.market, d.contract_id
  FROM bounds b
  JOIN marketdata.option_daily_snapshot d ON d.session_date = b.current_day
  JOIN marketdata.option_contract c ON c.id = d.contract_id
  JOIN marketdata.instrument ci ON ci.id = c.underlying_instrument_id
  WHERE ci.market = b.market
),
per_underlying AS (
  SELECT dn.market,
         i.market || ':' || i.code AS symbol,
         count(*) AS expected,
         count(*) FILTER (
           WHERE EXISTS (SELECT 1 FROM collected co
                          WHERE co.market = dn.market AND co.contract_id = dn.contract_id)
         ) AS covered
  FROM denom dn
  JOIN marketdata.instrument i ON i.id = dn.underlying_instrument_id
  GROUP BY 1, 2
),
-- ── #231 存在性层：缺席用**名册**判，与历史分母无关 ──────────────────────────────────────
-- 🚨 上面那套（分母取自基线日快照）**结构上判不出「连缺两轮」**：第二轮时该票在基线日也没有
--    行 ⇒ 不进分母 ⇒ `per_underlying` 无该行 ⇒ 判据对它**无输出** ⇒ ✅ 绿。
--    与 Prometheus「实例从服务发现消失后 `avg by (job)(up)` **returning nothing rather than
--    alerting**」逐字同构 —— 期望源取自被监控数据自身，数据消失把期望一起带走了。
--    ⇒ 缺席必须有一份**独立于快照表、且在数据消失时依然存在**的名册（同 `absent(up{job=…})`
--    里的 `up` 取自服务发现）。2026-08-27 `us:ALB` 实撞：连缺三轮，本探针只在第一轮可见。
--
-- 名册 = **us 工作集 ∧ 有未到期合约**。两个限定各自承重：
--   · `need_sync` —— 它就是锚闸（`anchor-driven-sync-gate.ts`）对锚表重算后的**物化结果**，
--     与采集侧同源；**删锚**后下一轮闸置 false ⇒ 该票自动离开名册。不挂它 = 删锚变永久假红。
--     🚫 MUST NOT 改读 `optionsdesk.anchor.excluded`：`excluded` 是**交易**意愿不是采集意愿
--     （FR-028 / Guardrail 8），prod 现有 3 只 `excluded=true` 的锚**照常在采**。
--   · **有未到期合约** —— 合约全到期的票本就无可采，留在名册里 = 每天假红一次。
--
-- 🚨 `baseline_day IS NULL` 时**整层不判**：全表无更早快照 = 采集尚未跑过第一轮，
--    此时谈「缺席」没有对象（上线首日的正常空态，同下面「无对象」那一档）。
--
-- 📌 **本层刻意不给「有行但少了几张」出力** —— 那是上面比例层的事。两层的期望源不同
--    （名册 vs 基线日），揉在一起就会回到「拉宽历史窗口」那条路：2026-08-27 prod 实测，
--    把分母拉到 21 自然日窗要多付 2.4× 耗时 + 342k buffers，而买到的信息**只有缺席那一只票**。
--
-- 复杂度：`present` 与 `collected` 同一趟当日行（已在缓存里）；`roster` 是 instrument 上的
-- 索引扫 + 每票一次 `option_contract (underlying_instrument_id, expiry_date)` 前导索引 EXISTS。
-- **无窗口扫、无全表扫。**
roster AS (
  SELECT b.market, i.id, i.market || ':' || i.code AS symbol
  FROM marketdata.instrument i, bounds b
  WHERE i.market = b.market AND i.need_sync
    AND EXISTS (SELECT 1 FROM marketdata.option_contract c
                WHERE c.underlying_instrument_id = i.id AND c.expiry_date >= b.current_day)
),
present AS (
  SELECT DISTINCT b.market, c.underlying_instrument_id AS iid
  FROM bounds b
  JOIN marketdata.option_daily_snapshot d ON d.session_date = b.current_day
  JOIN marketdata.option_contract c ON c.id = d.contract_id
  JOIN marketdata.instrument pi ON pi.id = c.underlying_instrument_id
  WHERE pi.market = b.market
),
absent AS (
  SELECT r.market, r.symbol,
         -- 缺席是**二值**的，分母只用来说明「有多少没采到」⇒ 取库内未到期合约数即可，
         -- 不必（也无从）取历史分母。判定本身不依赖这个数。
         (SELECT count(*) FROM marketdata.option_contract c, bounds b2
          WHERE b2.market = r.market
            AND c.underlying_instrument_id = r.id AND c.expiry_date >= b2.current_day) AS expected
  FROM roster r
  WHERE (SELECT bl.baseline_day FROM baseline bl WHERE bl.market = r.market) IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM present p WHERE p.market = r.market AND p.iid = r.id)
    -- 已被比例层收录的票不重复列（它在基线日有行 ⇒ 那边已给出 0/N）。
    AND NOT EXISTS (SELECT 1 FROM per_underlying pu
                     WHERE pu.market = r.market AND pu.symbol = r.symbol)
),
verdict AS (
  SELECT p.market, p.symbol, p.expected, p.covered,
         -- 乘法不除法：阈值 = 1 时退化成 `covered < expected` 的精确比较。
         p.covered::numeric < p.expected::numeric * (SELECT coverage_threshold FROM config)
           AS degraded
  FROM per_underlying p
  UNION ALL
  -- 存在性层：covered 恒 0、expected > 0 ⇒ 恒 degraded（名册说它该有，而它一行都没有）。
  SELECT a.market, a.symbol, a.expected::bigint, 0::bigint, true FROM absent a
)
, per_market AS (
SELECT
  b.market,
  -- 🚨 三档顺序**不可交换**（#276）: 先纯算术的周末闸（不读表, 日历坏掉时周末仍静默）,
  --    再 `unknown` 的 fail-closed, 最后才是 `non-trading` 的放行。把后两者对调 = 把
  --    「根本没填到这儿」读成「填过了确实没有」= 原样重犯 closed-world 那个病。
  CASE WHEN b.is_weekend                                       THEN 0
       WHEN NOT cal.has_row AND NOT cal.within_coverage        THEN 1
       WHEN NOT cal.has_row                                    THEN 0
       ELSE (EXISTS (SELECT 1 FROM verdict v
                      WHERE v.market = b.market AND v.degraded))::int END AS code,
  upper(b.market) || ' ' ||
  CASE
    -- 周末不判也**要说清楚为什么不判** —— 静默会被读成「判过了、没事」，那正是 044 的病灶形状。
    WHEN b.is_weekend
      THEN '✅ 非交易日不判 (当日 ' || b.current_day::text
        || ' 是周末 · ' || b.market || ' 不开盘, 本就无快照可核对)'
    -- `unknown`: 判**不出**, 与「判过了没事」是两件事 ⇒ 说清楚是哪一格缺, 别只报一个 🔴。
    WHEN NOT cal.has_row AND NOT cal.within_coverage
      THEN '🔴 判不出: 当日 ' || b.current_day::text
        || ' 落在 ' || b.market || ' 交易日历的已声明覆盖区间之外 (声明 '
        || coalesce((SELECT c.covered_from::text || '..' || c.covered_to::text
                     FROM marketdata.calendar_coverage c WHERE c.market = b.market), '缺')
        || '), 「今天是不是交易日」答不上来 ⇒ fail-closed 判红而非静默放行 (三态 unknown 档)'
    -- `non-trading`: 无行 **且** 落在已声明区间内 ⇒ 「填过了, 确实没有」。
    WHEN NOT cal.has_row
      THEN '✅ 非交易日不判 (当日 ' || b.current_day::text
        || ' 不在 ' || b.market || ' 交易日历, 且落在已声明覆盖区间内 ⇒ 休市, 本就无快照可核对)'
    ELSE
      (CASE WHEN EXISTS (SELECT 1 FROM verdict v WHERE v.market = b.market AND v.degraded)
            THEN '🔴 期权快照逐合约覆盖率跌破阈值'
            ELSE '✅ 期权快照逐合约完整性达标' END
      || ' (当日 ' || b.current_day::text
      || ' · 基线日 ' || coalesce((SELECT bl.baseline_day::text FROM baseline bl
                                   WHERE bl.market = b.market), '无')
      || ' · 阈值 ' || (SELECT (coverage_threshold * 100)::text FROM config) || '%): '
      -- 逐票全列（12 只白名单量级，单行放得下），degraded 的打 ⚠缺 —— 只报全局比值等于把小票
      -- 整票消失读没了，而那正是本判据存在的理由。
      || coalesce((SELECT string_agg(v.symbol || '=' || v.covered || '/' || v.expected
                                     || CASE WHEN v.degraded THEN '⚠缺' ELSE '' END,
                                     ' | ' ORDER BY v.symbol)
                   FROM verdict v WHERE v.market = b.market),
                  '无对象（基线日无存续合约 / 首日 / 零锚 —— 不是 0%）'))
  END AS text
  FROM bounds b JOIN calendar cal ON cal.market = b.market
)
-- 🚨 **契约仍是「恒返单行两列」**（bash 侧单次 read 读完 = 零逻辑的前提）：`per_market` 每市场
--    一行，这里用**无 GROUP BY 的聚合**收成恒 1 行（即使 `markets` 空表也返 1 行 NULL）。
-- 🚨 `max(code)` = **任一市场不健康即 exit 1**。🚫 MUST NOT 改成 `min` / 只看某个市场：
--    那等于让一个市场的绿把另一个市场的红盖掉，正是本探针存在的理由的反面。
-- 📌 两个市场**各出一段**、`||` 分隔且带 `US ` / `HK ` 前缀 —— 合并成一句会让「哪个市场缺」
--    重新变得不可读，而 #255 那次跨市场污染的教训正是「两个市场的结论必须分得开」。
SELECT coalesce(max(pm.code), 0) AS exit_code,
       coalesce(string_agg(pm.text, ' || ' ORDER BY pm.market), '无市场登记') AS summary
FROM per_market pm;
