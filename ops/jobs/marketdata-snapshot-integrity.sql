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
-- ═══ 🚨 本探针**只服务 us**，而这件事从 2026-08-28 起是写出来的，不再是「没写过滤条件」═══
-- #255：港股期权 2026-08-23 接入后，本文件的 baseline / denom / collected / present 四处仍是裸的
-- （只有 `roster` 带 `i.market = 'us'`）⇒ 港股合约混进美股分母。app 侧同一缺陷把港股票交给了
-- 美股补救器，按美股语义写库、1110 行 `oi_as_of` 差一天。四处现已全部显式收窄。
--
-- ⚠️ **港股侧目前没有独立探针 —— 跟踪在 #267**。app 内的两级补救已按市场参数化
--    （`option-snapshot-remediation.ts` 的 hk ①②），但那是进程内的；本文件这条「app 挂了也还在」
--    的独立通道（FR-051 的全部理由）仍只覆盖 us。
--    开 hk 探针的难点不在 SQL 而在**非交易日闸**：本文件这道是纯 `isodow` 的 ET 周末闸（不查
--    `trading_day`，故不构成 FR-045 禁的循环信任），港股照抄只能罩住周末 —— 公众假期（如
--    2026-10-01 / 2026-10-19）仍会各假红一次，而每月假红一次的告警等于没有告警。判据设计见 #267。
--    **别把这件事默默留成空白** —— 它现在写在这里，是为了下一个读本文件的人知道它是空白。
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
-- 🚨 #255：必须按市场取。取全表最近一天时，一个「us 休市、hk 开市」的日子会被选成基线
--    ⇒ 分母整个来自港股。2026-10-01 / 2026-10-19 就是这样的日子（us whole / hk 无行）。
-- 🚨 写成 `ORDER BY … DESC LIMIT 1` 而不是 `max()`：带 join 之后 `max()` 拿不到「索引倒序扫、
--    命中第一行就停」的形状，会退化成聚合全扫。本形状与 TS 侧 `findFirst(orderBy desc)` 同源。
baseline AS (
  SELECT (SELECT d.session_date
          FROM marketdata.option_daily_snapshot d
          JOIN marketdata.option_contract c ON c.id = d.contract_id
          JOIN marketdata.instrument i ON i.id = c.underlying_instrument_id,
               bounds b
          WHERE d.session_date < b.current_day
            AND i.market = 'us'
          ORDER BY d.session_date DESC
          LIMIT 1) AS baseline_day
),
-- 分母：同一合约在基线日可能有 eod + premarket_backfill 两行 ⇒ **DISTINCT 去重**，否则靠兜底
-- 补采续命的那些票分母会凭空翻倍、覆盖率恒判红。
-- 🚨 #255：市场谓词钉在**标的**（`instrument.market`）而不是 `option_contract.market`。
--    本判据的单位是「票」，而两列可以不一致 —— #199 那批跨市场幽灵合约正是 `c.market='us'`
--    挂在港股标的名下，按合约列过滤会把它们放回美股分母。TS 侧 `option-snapshot-coverage.check.ts`
--    的四处查询用的是同一个谓词，**改一处必须改另一处**。
denom AS (
  SELECT DISTINCT d.contract_id, c.underlying_instrument_id
  FROM marketdata.option_daily_snapshot d
  JOIN marketdata.option_contract c ON c.id = d.contract_id
  JOIN marketdata.instrument di ON di.id = c.underlying_instrument_id,
       baseline bl, bounds b
  WHERE d.session_date = bl.baseline_day
    AND c.expiry_date >= b.current_day
    AND di.market = 'us'
),
-- 分子：当日实得的合约集（同样多来源去重）。
collected AS (
  SELECT DISTINCT d.contract_id
  FROM marketdata.option_daily_snapshot d
  JOIN marketdata.option_contract c ON c.id = d.contract_id
  JOIN marketdata.instrument ci ON ci.id = c.underlying_instrument_id,
       bounds b
  WHERE d.session_date = b.current_day
    AND ci.market = 'us'
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
  SELECT i.id, i.market || ':' || i.code AS symbol
  FROM marketdata.instrument i, bounds b
  WHERE i.market = 'us' AND i.need_sync
    AND EXISTS (SELECT 1 FROM marketdata.option_contract c
                WHERE c.underlying_instrument_id = i.id AND c.expiry_date >= b.current_day)
),
present AS (
  SELECT DISTINCT c.underlying_instrument_id AS iid
  FROM marketdata.option_daily_snapshot d
  JOIN marketdata.option_contract c ON c.id = d.contract_id
  JOIN marketdata.instrument pi ON pi.id = c.underlying_instrument_id,
       bounds b
  WHERE d.session_date = b.current_day
    AND pi.market = 'us'
),
absent AS (
  SELECT r.symbol,
         -- 缺席是**二值**的，分母只用来说明「有多少没采到」⇒ 取库内未到期合约数即可，
         -- 不必（也无从）取历史分母。判定本身不依赖这个数。
         (SELECT count(*) FROM marketdata.option_contract c, bounds b2
          WHERE c.underlying_instrument_id = r.id AND c.expiry_date >= b2.current_day) AS expected
  FROM roster r
  WHERE (SELECT baseline_day FROM baseline) IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM present p WHERE p.iid = r.id)
    -- 已被比例层收录的票不重复列（它在基线日有行 ⇒ 那边已给出 0/N）。
    AND NOT EXISTS (SELECT 1 FROM per_underlying pu WHERE pu.symbol = r.symbol)
),
verdict AS (
  SELECT p.symbol, p.expected, p.covered,
         -- 乘法不除法：阈值 = 1 时退化成 `covered < expected` 的精确比较。
         p.covered::numeric < p.expected::numeric * (SELECT coverage_threshold FROM config)
           AS degraded
  FROM per_underlying p
  UNION ALL
  -- 存在性层：covered 恒 0、expected > 0 ⇒ 恒 degraded（名册说它该有，而它一行都没有）。
  SELECT a.symbol, a.expected::bigint, 0::bigint, true FROM absent a
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
