-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 交易日历健康谓词（044 US3）—— **单一共享产物 / 唯一判断所在地**。
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
-- 已知消费方（改谓词 = 同时改这些的行为，全部会被下面那个 IT 兜住）：
--   · `apps/server/test/integration/marketdata.calendar-044.health.it.spec.ts`（**真测本文件**，T013）
--   · `ops/jobs/marketdata-calendar-health.sh`（独立探针，每 4h，T014）
--   · `ops/jobs/marketdata-sync-marketdata-sync-report.sh`（夜间同步看守的「日历还可信吗」前置档，T015）
--
-- **自包含 / 无参数**（阈值写死在下面）：传参 = 把判断挪回 bash = 前功尽弃。
--
-- 契约（bash 零逻辑的前提，由 IT 断言锁死）：恒返 **单行两列** `exit_code` `summary`；
-- `exit_code ∈ {0,1}` 直接就是退出码；`summary` 单行、无 tab/换行 → 单次 `read` 即可解析。
--
-- 判据（**任一成立即不健康 → exit 1**）：
--   ① 陈旧：受监控市场任一 `last_success_at` 超 **26h**（或缺行 / 从未成功）
--   ② 降级：受监控市场任一 `served_by` 非**该市场的**主源（FR-014「降级 ≠ 健康」）
--
-- 阈值论证（26h）：填充 @21:00 → 上次成功 = D 日 21:00；D+1 21:00 那次失败时心跳龄 = 24h
-- → 26h 闸于 D+1 23:00 触发 = 首次失败后 ~2h 告警。满足 SC-003（24h 内）且给单次抖动留余量。
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
-- 驱动 —— 直接 `min(last_success_at) > 26h` 判空表会得 NULL → 「没有任何行超阈」→ **假绿**，
-- 那正是 044 事故的病灶形状（无声被读成正常）。缺行 / NULL 一律判不健康。
-- ─────────────────────────────────────────────────────────────────────────────────────────────
WITH watched(market, primary_source) AS (
  VALUES ('cn', 'tencent'), ('hk', 'tencent'), ('us', 'futu')
),
verdict AS (
  SELECT
    w.market,
    c.last_success_at,
    c.served_by,
    -- 缺行 / 从未成功 → last_success_at IS NULL → 判陈旧（不是判健康）。
    (c.last_success_at IS NULL OR c.last_success_at < now() - interval '26 hours') AS stale,
    -- IS DISTINCT FROM: served_by 为 NULL（缺行 / 从未成功过）时亦判降级，不被 NULL 静默放行。
    -- 比对的是**该市场自己的**主源（w.primary_source），不是某个全局常量。
    (c.served_by IS DISTINCT FROM w.primary_source) AS degraded
  FROM watched w
  LEFT JOIN marketdata.calendar_sync_health c ON c.market = w.market
)
SELECT
  (count(*) FILTER (WHERE stale OR degraded) > 0)::int AS exit_code,
  CASE WHEN count(*) FILTER (WHERE stale OR degraded) > 0
       THEN '🔴 交易日历不健康'
       ELSE '✅ 交易日历健康'
  END
  || ' (阈值 26h · 监控 cn/hk/us · 主源 cn,hk=tencent us=futu): '
  || string_agg(
       market || '='
       || CASE WHEN last_success_at IS NULL
               THEN '从未成功'
               ELSE round(extract(epoch FROM now() - last_success_at) / 3600)::text || 'h前'
          END
       || CASE WHEN stale THEN '⚠陈旧' ELSE '' END
       || '/' || coalesce(served_by, '?')
       || CASE WHEN degraded THEN '⚠降级' ELSE '' END,
       ' | ' ORDER BY market
     ) AS summary
FROM verdict;
