-- 非 marketdata 侧的应用状态健康谓词 —— 单一共享产物 / 唯一判断所在地(照 044 / table-health 范式)。
--
-- 🚨🚨 动它前先读完本段, 它是宪法 §II 合规链条的一环。
--
-- 仓内无 bash 测试框架 ⇒ `app-state-health.sh` 里的判断无覆盖。故 bash 压到零逻辑, 判断全在本
-- 文件, 由 Testcontainers IT 真测(`apps/server/test/integration/app-state-health.it.spec.ts`,
-- 每条判据配一条**注入故障要求翻红**的变异用例)。
--
--   ⇒ 消费方**一律读本文件**, 禁止在 bash / IT / 任何地方内联复制。两份必 drift。
--
-- 契约(由 IT 断言锁死): 恒返**单行两列** `exit_code` `summary`; `exit_code ∈ {0,1}` 直接作退出码;
-- `summary` 单行、无 tab/换行。自包含无参数(阈值写死在本文件内)。
--
-- ═══ 它为什么存在 ═══
--
-- #209 排查(2026-08-27)发现: 三个既有数据探针的谓词**全部只碰 `marketdata` schema** ⇒
-- `optionsdesk` / `alert` / `public.outbox_event` / `account` / `research` / `ideation`
-- **零进程外监控**。而 `optionsdesk/sync-anchor-last-close.scheduler.ts` 的失败路径是
-- `catch → logger.error → return null`, **不落 `sync_run`**(不在 marketdata 同步框架内) ⇒
-- 纯真空: 日志没有接收端, 数据侧也没人看。
--
-- ═══ 🚨 为什么只覆盖两条, 而不是把那 6 个 schema 都做一遍 ═══
--
-- 2026-08-27 prod 实况: `alert.push_delivery` **0 行**、`alert.alert` **0 条**;
-- `account.account` **5 个**(维护者测试号); `ideation.idea_session` 6; `research.research_report` 27。
-- ⇒ 这些今天**断言不了任何东西**。没有基线的探针要么永不触发(装饰), 要么对空集报警(噪声),
--   两种都在腐蚀告警面的可信度 —— 而 044 已经论证过「误报训练出狼来了, 比漏报更毁可信度」。
--   **等它们真被用起来、有了稳态基线再加**, 别为了凑覆盖率现在就写。
--
-- ═══ 判据(任一成立即不健康 → exit 1) ═══
--   ① 锚收盘价**整体**停摆: **全部** active 锚的 `last_close_date` 都早于 expected_day
--   ② 锚工作集为空: active 锚数为 0(「空工作集」也是要抓的签名之一)
--   ③ 日历缺失: **任一** active 锚的市场算不出 expected_day(`trading_day` 未填充到位) → 判不健康
--
-- 🚨 ③ 取 `bool_or` 而非 `bool_and`, 这不是风格问题 —— 初版写成 `bool_and` 时它是**死判据**:
--    日历全缺 ⇒ 所有锚都算不新鲜 ⇒ ① 先触发, ③ 永无独立生效的机会; 而**混合市场**(us 有日历、
--    hk 没有)时 `bool_and` 为假、① 也不触发(us 锚新鲜) ⇒ 那些 hk 锚被静默当成陈旧、无人告警。
--    正是 ③ 本该堵的洞。这个缺陷由变异测试抓出(「让 ③ 永不触发」跑出 8/8 全绿 = 它没被测到)。
--   ④ outbox 卡住: 存在 `published_at IS NULL` 且已超期的事件
--
-- 🚨 ① 取 **AND 语义**(全部掉队才红), 与 table-health 的 cn/hk 哨兵同一取舍: 单只停牌/退市/
--    新建锚不该判成整条投影停摆。**代价写在明处: 单只锚长期掉队本谓词看不见** —— summary 里
--    报 `fresh/total` 让它可见但不判红。要抓单只, 得先想清楚停牌怎么排除, 别顺手把 AND 改 OR。
--
-- 🚨 ④ 的阈值 15 分钟不是拍的: `OutboxEventCronPublisher` 是 `@Cron EVERY_10_SECONDS` ⇒
--    15 分钟 = 90 倍余量。一条事件超期 = relay 真的停了(进程死 / 订阅方持续抛), 不是排队。
--
-- 🚨 **装机时序**(同 table-health 记的那条): 加新判据前先确认 prod 当下满足它, 否则装机即假红、
--    每 4h 推一条。本批两条的上线前实测: active 锚 109 只、`last_close_date` 最新 2026-08-26、
--    `no_close = 0`; outbox 105 行、未派发 **0**。

WITH today AS (
  -- 业务「今天」锚在 Asia/Shanghai(同 table-health; 阈值以交易日为单位, 容器 TZ 偏移不影响)。
  SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date AS d
),
-- 允许锚落后多少个**交易日**(非自然日, 长假不误报)。取 2 与 table-health 的日线哨兵同值。
--
-- 🚨 ADR-0070 后**上游换人但阈值不变**: 收盘价改由 `sync-anchor-last-close` 在各市场收盘后
-- 直查 vendor 写入(hk 16:10 / us 16:15 当地), 比原来的 daily_bar 每小时投影**更早**到货
-- ⇒ 2 个交易日的余量只增不减。真正的变化是**补采窗按交易所当地日历日封口**: 某一场窗内
-- 一直失败就不再追那一场(跨午夜即放弃), 于是「掉队」从「投影慢了」变成「那一场彻底没采到」
-- —— 判据面不变, 但它现在指向的是一个**更值得看**的故障。
lag_cfg(max_lag_trading_days) AS (VALUES (2)),
-- 各市场按日期倒序编号的交易日(rn=1 = 最近一个 <= today 的交易日)。trading_day 是小表, pkey 覆盖。
cal AS (
  SELECT t.market, t.date, row_number() OVER (PARTITION BY t.market ORDER BY t.date DESC) AS rn
  FROM marketdata.trading_day t, today
  WHERE t.date <= today.d
),
-- 每个市场的 expected_day。日历不足 → NULL → 下游 fail-closed 判红。
deadline AS (
  SELECT c.market,
         (SELECT c2.date FROM cal c2, lag_cfg l
           WHERE c2.market = c.market AND c2.rn = l.max_lag_trading_days + 1) AS expected_day
  FROM (SELECT DISTINCT market FROM cal) c
),
-- active 锚 = 未被排除的锚。逐锚判新鲜: `>= expected_day`; expected_day IS NULL 或 last_close_date
-- IS NULL ⇒ 比较非真 ⇒ 记为不新鲜(fail-closed)。
anchor_probe AS (
  SELECT a.ticker, a.market,
         d.expected_day,
         coalesce(a.last_close_date >= d.expected_day, false) AS is_fresh
  FROM optionsdesk.anchor a
  LEFT JOIN deadline d ON d.market = a.market
  WHERE NOT a.excluded
),
anchor_verdict AS (
  SELECT count(*)                              AS total,
         count(*) FILTER (WHERE is_fresh)      AS fresh,
         min(expected_day)                     AS expected_day,
         bool_or(expected_day IS NULL)         AS calendar_missing,
         -- ① 全部掉队(AND 语义) · ② 空工作集 · ③ 日历缺失 —— 三者任一即红
         (count(*) = 0)                                     AS empty_workset,
         (count(*) > 0 AND count(*) FILTER (WHERE is_fresh) = 0) AS all_stale
  FROM anchor_probe
),
outbox_verdict AS (
  SELECT count(*) AS stuck,
         (min(created_at) AT TIME ZONE 'Asia/Shanghai')::timestamp(0) AS oldest_cst
  FROM public.outbox_event
  WHERE published_at IS NULL
    AND created_at < now() - interval '15 minutes'
)
SELECT
  CASE WHEN (SELECT empty_workset OR all_stale OR calendar_missing FROM anchor_verdict)
         OR (SELECT stuck > 0 FROM outbox_verdict)
       THEN 1 ELSE 0 END AS exit_code,
  'anchor_close=' || (SELECT fresh || '/' || total FROM anchor_verdict)
  || coalesce('@' || (SELECT expected_day::text FROM anchor_verdict), '@日历缺失')
  -- 🚨 顺序承重: 「判不了」(日历缺失)必须压过「判出来是坏的」(整体停摆) —— 日历全缺时两者同时
  -- 为真, 报成「整体停摆」会把人引向采集侧, 而真正该修的是日历。
  || CASE WHEN (SELECT calendar_missing FROM anchor_verdict) THEN '⚠日历缺失'
          WHEN (SELECT empty_workset FROM anchor_verdict) THEN '⚠空工作集'
          WHEN (SELECT all_stale FROM anchor_verdict) THEN '⚠整体停摆'
          ELSE '' END
  || ' | outbox_stuck=' || (SELECT stuck FROM outbox_verdict)
  || coalesce(' (最老 ' || (SELECT oldest_cst::text FROM outbox_verdict) || ')', '')
  || CASE WHEN (SELECT stuck > 0 FROM outbox_verdict) THEN '⚠relay 停摆' ELSE '' END
  AS summary;
