-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 交易日历健康谓词（044 US3 心跳档 + 062 US4 视野档）—— **单一共享产物 / 唯一判断所在地**。
--
-- 🚨🚨 这个文件是宪法 §II 合规的承重墙，动它前先读完本段。
--
-- 仓内无 bash 测试框架 → `marketdata-calendar-health.sh` / `marketdata-sync-report.sh` 无法 RED-first，直接撞宪法 §II
-- （NON-NEGOTIABLE）。裁决（analyze A2 → user 2026-07-16）= **把 bash 压到零逻辑**：
-- 所有判断下沉到本谓词，bash 只剩「跑它 → `exit $exit_code` → 打印 summary」。
--
--   ⇒ 消费方 **一律读本文件**，**禁止**在 bash / IT / 任何地方内联复制一份 SQL。
--     两份必 drift，一 drift「判断逻辑已被真测」就当场变成假话，§II 合规名存实亡。
--
-- 已知消费方（改谓词 = 同时改这些的行为，全部会被下面那两个 IT 兜住）：
--   · `apps/server/test/integration/marketdata.calendar-044.health.it.spec.ts`（**真测心跳档**，044 T013）
--   · `apps/server/test/integration/marketdata.calendar-062.horizon-probe.it.spec.ts`（**真测视野档**，062 T011）
--   · `ops/jobs/marketdata-calendar-health.sh`（独立探针，每 4h，044 T014）
--   · `ops/jobs/marketdata-sync-report.sh`（夜间同步看守的「日历还可信吗」前置档，044 T015）
--
-- **自包含 / 无参数**（阈值写死在下面）：传参 = 把判断挪回 bash = 前功尽弃。
--
-- 契约（bash 零逻辑的前提，由 IT 断言锁死）：恒返 **单行两列** `exit_code` `summary`；
-- `exit_code ∈ {0,1}` 直接就是退出码；`summary` 单行、无 tab/换行 → 单次 `read` 即可解析。
--
-- ═══ 判据（**任一成立即不健康 → exit 1**）═══
--
-- 【心跳档 —— 「填充还活着吗」（liveness，044）】
--   ① 陈旧：受监控市场任一 `last_success_at` 超 **26h**（或缺行 / 从未成功）
--   ② 降级：受监控市场任一 `served_by` 非**该市场的**主源（FR-014「降级 ≠ 健康」）
--
-- 【视野档 —— 「视野还在往前走吗」（coverage，062 FR-016）】由重到轻三档：
--   ③ **无覆盖声明**（`calendar_coverage` 缺该市场行）→ 最重一档：连「填到哪儿了」这个承诺
--     都没有 ⇒ 该市场每一天都是 `unknown`。文案与「视野过近」**刻意可区分**（US4 AS4）。
--   ④ **视野落后**：`covered_to < current_date` —— 声明连今天都没覆盖到，「今天是不是交易日」
--     只能答 `unknown`（视野停了不止一两天）。
--   ⑤ **视野过近**：`covered_to` 之后（严格说是 `(current_date, covered_to]` 内）的交易日数
--     **< 5**，且 `covered_to` **未抵当年 12-31**（年末豁免，见下）。
--
-- 🚨🚨 **年末豁免只在「当年」成立 —— 1 月 1 日起转红是有意的，MUST NOT「修」它。**
--   豁免的表达式是「`covered_to` 已抵**当年** 12-31」：次年年历尚未发布时，前瞻填充按设计停在
--   当年末（`static-calendar.adapter.ts` 整段 throw，不伪造次年日期），此时视野再短也不该告警
--   —— 否则每年 12 月必假红，训练出「这条可以忽略」。
--   跨年那一刻「当年」变成新年 ⇒ `covered_to`（旧年 12-31）`< current_date` ⇒ 落进第 ④ 档、
--   **必红**，直到次年年历的年更 PR 合入才自动转绿。**这正是设计**：年历没更就该响。
--   🚫 **MUST NOT 把豁免延到次年**（写成「任一年的 12-31 都豁免」）。
--   🚫 **MUST NOT 加「1 月宽限期」。**
--   两者都等于把唯一会响的信号关掉，而年更漏跑的后果是**整年日历失真**（每天都在 `unknown`
--   与错判之间摇摆）。机器化断言：`marketdata.calendar-062.horizon-probe.it.spec.ts` 那条
--   「终点 = 上一年 12-31 → 必须 exit 1」—— 谁把豁免延长，它立刻红。
--
-- ⚠️ **`current_date` 是 DB 服务器（UTC）口径**，与各市场「今天」最多差一天。阈值取 5 个交易日
--   ⇒ 1 天偏差不会假红。**这个容差是刻意的** —— 别为了精确把市场时区搬进 SQL，那就成了仓内
--   **第三份**时区表（另两份在 `trading-day-gate.ts` 与各 vendor adapter），必漂移。
--
-- 🚨 **心跳档与视野档并存且 MUST NOT 互相替代**（062 FR-017）：填充可以每晚成功（心跳全绿）
--   而视野一天都不往前走（源恒返旧数据 / 年历漏更）；反之填充挂了但声明还停在一个很远的终点。
--   两档各答一问，合并成一条 = 又焊死两个语义。
--
-- 阈值论证（26h）：填充 @21:00 → 上次成功 = D 日 21:00；D+1 21:00 那次失败时心跳龄 = 24h
-- → 26h 闸于 D+1 23:00 触发 = 首次失败后 ~2h 告警。满足 SC-003（24h 内）且给单次抖动留余量。
-- 阈值论证（5 个交易日）：前瞻段每晚推到当年末，正常态余量是几十到两百个交易日；掉到 5 个
-- 以内意味着前瞻段已连续多日整段失败 —— 留出 ~1 周人工介入窗口（重跑 seed / 补年历）。
--
-- 监控面 = **cn + hk + us**（2026-07-31 起纳入 us，sellput-viz Phase 1 #5）。
-- ⚠️ 044 原文这里写的是「us 有意排除」，理由是「L2 静态层不覆盖 us ⇒ us 陈旧无备源可用、
-- 也无从修，纳入只会制造修不掉的常亮告警」。**该理由已失效**：us 换源后有
-- `[富途 L1, 腾讯 L2]` 两个走不同物理通路的活源，陈旧时有备源可用、也有得修；而即将上线的
-- 6 个 `{us}`-only 期权维度会拿 us 日历判交易日闸 —— 不监控它，044 事故就换到 us 重演一遍。
--
-- 🚨 **主源是 per-market 的**：cn/hk = `tencent`，us = `futu`（us 的腾讯是 L2）。别退回单个
-- 全局主源常量 —— 那样 us 正常运行会被判成「降级」，一天到晚常亮。
-- 🚨 us **蓄意无 L3**（user 2026-07-31 拍板）：双源全挂时本探针报警 → 人工 seed 救，
-- 不补静态年历。见 `apps/server/src/marketdata/static-calendar.adapter.ts` 绊线段。
--
-- 🚨 沉默 ≠ 健康：由固定市场清单 `VALUES ('cn',…),('hk',…),('us',…)` **LEFT JOIN** 心跳表
-- 与覆盖声明表驱动 —— 直接 `min(last_success_at) > 26h` 判空表会得 NULL → 「没有任何行超阈」→
-- **假绿**，那正是 044 事故的病灶形状（无声被读成正常）。缺行 / NULL 一律判不健康。
--
-- 🚫 **MUST NOT 用 `max(trading_day.date)` 当视野终点**（062 FR-003）：最大值看不出区间中间的
-- 空洞，那是「库里没有的即为假」的同款推断。视野终点的唯一真相源是 `calendar_coverage`，它只在
-- 某段**整段填充成功**后才前进（`calendar-coverage.rules.ts`）。机器强制在
-- `scripts/checks/check-trading-day-read.ts` Check B。
-- ─────────────────────────────────────────────────────────────────────────────────────────────
WITH watched(market, primary_source) AS (
  VALUES ('cn', 'tencent'), ('hk', 'tencent'), ('us', 'futu')
),
observed AS (
  SELECT
    w.market,
    h.last_success_at,
    h.served_by,
    -- 缺行 / 从未成功 → last_success_at IS NULL → 判陈旧（不是判健康）。
    (h.last_success_at IS NULL OR h.last_success_at < now() - interval '26 hours') AS stale,
    -- IS DISTINCT FROM: served_by 为 NULL（缺行 / 从未成功过）时亦判降级，不被 NULL 静默放行。
    -- 比对的是**该市场自己的**主源（w.primary_source），不是某个全局常量。
    (h.served_by IS DISTINCT FROM w.primary_source) AS degraded,
    c.covered_to,
    -- 视野余量 = 今天之后、声明终点之前（闭区间）**已落库的交易日数**。
    -- ⚠️ 数的是 `trading_day` 的真实行，不是日历天数：真实行才反映「这几天里真有几场可交易」。
    -- c.covered_to 为 NULL（无声明）时 `date <= NULL` 恒 NULL → 计 0，由第 ③ 档接管。
    (SELECT count(*)
       FROM marketdata.trading_day td
      WHERE td.market = w.market
        AND td.date > current_date
        AND td.date <= c.covered_to) AS runway
  FROM watched w
  LEFT JOIN marketdata.calendar_sync_health h ON h.market = w.market
  LEFT JOIN marketdata.calendar_coverage c ON c.market = w.market
),
verdict AS (
  SELECT
    o.*,
    -- ③ 声明整体缺失（最重一档）。
    (o.covered_to IS NULL) AS no_coverage,
    -- ④ 视野已落后于今天。
    (o.covered_to IS NOT NULL AND o.covered_to < current_date) AS horizon_behind,
    -- ⑤ 视野过近 + **年末豁免**。三个前提缺一不可：有声明、终点不早于今天（否则归 ④ 档，
    --    一个市场只报最重的那一档）、且终点**未抵当年 12-31**。
    --    🚨🚨 `make_date(extract(year FROM current_date)…)` 里的年份是**当年**，跨年后自动
    --    变成新年 —— 这是 Guardrail 11 的落点，MUST NOT 改成「任一年的 12-31」。
    (o.covered_to IS NOT NULL
      AND o.covered_to >= current_date
      AND o.covered_to < make_date(extract(year FROM current_date)::int, 12, 31)
      AND o.runway < 5) AS horizon_short
  FROM observed o
)
SELECT
  (count(*) FILTER (WHERE stale OR degraded OR no_coverage OR horizon_behind OR horizon_short) > 0)::int
    AS exit_code,
  CASE WHEN count(*) FILTER (WHERE stale OR degraded OR no_coverage OR horizon_behind OR horizon_short) > 0
       THEN '🔴 交易日历不健康'
       ELSE '✅ 交易日历健康'
  END
  || ' (心跳 26h · 视野 5 个交易日 · 监控 cn/hk/us · 主源 cn,hk=tencent us=futu): '
  || string_agg(
       market || '='
       || CASE WHEN last_success_at IS NULL
               THEN '从未成功'
               ELSE round(extract(epoch FROM now() - last_success_at) / 3600)::text || 'h前'
          END
       || CASE WHEN stale THEN '⚠陈旧' ELSE '' END
       || '/' || coalesce(served_by, '?')
       || CASE WHEN degraded THEN '⚠降级' ELSE '' END
       -- 视野段：终点 + 余量必须都出现在摘要里（US4 AS1「指明是哪个市场、停在哪天」）。
       || ' 视野'
       || CASE WHEN no_coverage
               THEN '⚠无覆盖声明'
               ELSE covered_to::text || '(余量' || runway::text || '个交易日)'
                    || CASE WHEN horizon_behind THEN '⚠视野落后' ELSE '' END
                    || CASE WHEN horizon_short THEN '⚠视野过近' ELSE '' END
          END,
       ' | ' ORDER BY market
     ) AS summary
FROM verdict;
