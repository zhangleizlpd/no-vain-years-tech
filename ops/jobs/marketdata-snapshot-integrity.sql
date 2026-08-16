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
--    （~104 条/年）。⇒ 本谓词自带一道 **ET 周末闸**（下面 `bounds.is_et_weekend`）：当日落在
--    ET 周六 / 周日 ⇒ exit 0，且 summary 显式写明「不判」（**不静默**）。
--
-- 🚨 **周末闸与上面那条「MUST NOT 用交易日历」不是一类东西，别把它当成破例**：
--    那条禁的是**查 `trading_day` 表**来放宽 / 跳过判定 —— 那张表正是采集管线交易日闸读的同一张，
--    日历一坏 ⇒ 采集跳过真交易日 ⇒ 谓词跟着闭嘴，**恰好瞎在最该告警的地方**（044 病灶形状）。
--    而周末闸是 `isodow` **纯日期算术，不读任何表、不依赖任何被监控对象**：周六周日永远不是 us
--    交易日，那两天根本不存在「本该有快照却没有」这个状态 ⇒ 消掉它**零检测力损失**。
--
-- 🚨 **美股节假日仍然会假红**（~9-10 次/年），这是**蓄意保留**：要消掉它就必须查 `trading_day`，
--    那就正好踩进上一段那个循环信任陷阱。节假日是已知日期、一年十次、看一眼即弃 —— 代价远小于
--    让这个探针获得「跟着日历一起瞎」的能力。**别顺手把它也修了。**
--
-- ═══ 当日 = **ET 的今天**，不是宿主的今天 ═══
-- `session_date` 是按 us 市场时区求值的业务日（FR-036）。timer 跑在北京 08:00 = ET 前一日
-- 19:00/20:00 ⇒ ET 日期正是刚采完的那一场。用 `Asia/Shanghai` 会**恒偏一天**、每天整批假红。
--
-- 🚨 **「当日」可注入，且注入点只为可测性存在**：`current_setting('nvy.current_day', true)` 非空
--    时覆盖它。**生产从不设这个 GUC** —— `.sh` 不传 `-v`、不设任何 SET ⇒ 恒走 `now()` 那支。
--    它存在的唯一理由：周末闸的判据是「今天星期几」，不可注入就只能靠「等到周六再跑一次 IT」来
--    验 = 等于没验，而未被真测的判断正是宪法 §II 要堵的洞。IT 用 `SET LOCAL` 在事务内钉死日期，
--    并另留一条**不注入**的用例守住上面那条 ET 时区判据（否则改成 Asia/Shanghai 也没人发现）。
--    ⚠️ 它同时是个**静音开关**：谁要是 `ALTER DATABASE … SET nvy.current_day`，探针会天天核对
--    同一个历史日、永远绿。别这么干，也别把它接进任何 env / 配置文件。
--
-- ═══ 性能 ═══
-- 两次以 `session_date` 为入口的查询，走 `ix_option_daily_snapshot_session_date`；合约按主键
-- join。**没有任何全表扫**（本表是全库增长最快的表，约 6.4M 行/年）。O(两日快照行数之和)。
-- ─────────────────────────────────────────────────────────────────────────────────────────────
WITH bounds AS (
  SELECT anchor.current_day,
         -- ET 周六(6) / 周日(7)：us 不开盘 ⇒ 当日本就不存在快照，判它 = 每周两条假红（见文件头）。
         -- **纯 isodow 算术，不读任何表** —— 与被禁的「查交易日历放宽判定」不是一类。
         EXTRACT(isodow FROM anchor.current_day) >= 6 AS is_et_weekend
  FROM (
    SELECT coalesce(
             -- 仅测试注入（见文件头）；生产从不设此 GUC ⇒ 恒走下面的 now() 那支。
             nullif(current_setting('nvy.current_day', true), '')::date,
             (now() AT TIME ZONE 'America/New_York')::date
           ) AS current_day
  ) anchor
),
-- 🚨 **阈值的唯一所在地**（先验起手 1 = 100%，FR-045）。它与 TS 侧的
--    `MARKETDATA_OPTION_COVERAGE_THRESHOLD`（zod 默认 1）是**同一个口径的两处实现** ——
--    改一处必须改另一处，IT 里那条「9/10 覆盖」的用例就是拿来撞这个 drift 的。
config AS (
  SELECT 1::numeric AS coverage_threshold
),
-- 基线日 = 有快照行的、早于当日的最近一个交易日（见文件头）。全表无更早行 → NULL → 分母为空。
baseline AS (
  SELECT (SELECT max(d.session_date)
          FROM marketdata.option_daily_snapshot d, bounds b
          WHERE d.session_date < b.current_day) AS baseline_day
),
-- 分母：同一合约在基线日可能有 eod + premarket_backfill 两行 ⇒ **DISTINCT 去重**，否则靠兜底
-- 补采续命的那些票分母会凭空翻倍、覆盖率恒判红。
denom AS (
  SELECT DISTINCT d.contract_id, c.underlying_instrument_id
  FROM marketdata.option_daily_snapshot d
  JOIN marketdata.option_contract c ON c.id = d.contract_id,
       baseline bl, bounds b
  WHERE d.session_date = bl.baseline_day
    AND c.expiry_date >= b.current_day
),
-- 分子：当日实得的合约集（同样多来源去重）。
collected AS (
  SELECT DISTINCT d.contract_id
  FROM marketdata.option_daily_snapshot d, bounds b
  WHERE d.session_date = b.current_day
),
per_underlying AS (
  SELECT i.market || ':' || i.code AS symbol,
         count(*) AS expected,
         count(*) FILTER (
           WHERE EXISTS (SELECT 1 FROM collected co WHERE co.contract_id = dn.contract_id)
         ) AS covered
  FROM denom dn
  JOIN marketdata.instrument i ON i.id = dn.underlying_instrument_id
  GROUP BY 1
),
verdict AS (
  SELECT p.symbol, p.expected, p.covered,
         -- 乘法不除法：阈值 = 1 时退化成 `covered < expected` 的精确比较。
         p.covered::numeric < p.expected::numeric * (SELECT coverage_threshold FROM config)
           AS degraded
  FROM per_underlying p
)
SELECT
  CASE WHEN b.is_et_weekend
       THEN 0
       ELSE (EXISTS (SELECT 1 FROM verdict WHERE degraded))::int END AS exit_code,
  CASE
    -- 周末不判也**要说清楚为什么不判** —— 静默会被读成「判过了、没事」，那正是 044 的病灶形状。
    WHEN b.is_et_weekend
      THEN '✅ 非交易日不判 (当日 ' || b.current_day::text
        || ' 是 ET 周末 · us 不开盘, 本就无快照可核对)'
    ELSE
      (CASE WHEN EXISTS (SELECT 1 FROM verdict WHERE degraded)
            THEN '🔴 期权快照逐合约覆盖率跌破阈值'
            ELSE '✅ 期权快照逐合约完整性达标' END
      || ' (当日 ' || b.current_day::text
      || ' · 基线日 ' || coalesce((SELECT baseline_day::text FROM baseline), '无')
      || ' · 阈值 ' || (SELECT (coverage_threshold * 100)::text FROM config) || '%): '
      -- 逐票全列（12 只白名单量级，单行放得下），degraded 的打 ⚠缺 —— 只报全局比值等于把小票
      -- 整票消失读没了，而那正是本判据存在的理由。
      || coalesce((SELECT string_agg(symbol || '=' || covered || '/' || expected
                                     || CASE WHEN degraded THEN '⚠缺' ELSE '' END,
                                     ' | ' ORDER BY symbol)
                   FROM verdict),
                  '无对象（基线日无存续合约 / 首日 / 零锚 —— 不是 0%）'))
  END AS summary
-- bounds 恒 1 行 ⇒ 「恒返单行两列」的契约不变（bash 侧单次 read 读完 = 零逻辑的前提）。
FROM bounds b;
