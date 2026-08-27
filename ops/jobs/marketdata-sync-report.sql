-- marketdata 夜间同步日报的**取数 + findings 展开判据** —— 单一共享产物, 照 044 / 047 探针范式。
--
-- 🚨🚨 动它前先读完本段。
--
-- 仓内无 bash 测试框架 ⇒ 写在 `marketdata-sync-report.sh` 里的判断无覆盖, 直接撞宪法 §II
-- (NON-NEGOTIABLE)。本文件把**取数与 findings 展开判据**下沉出来, 由 Testcontainers IT 真测
-- (`apps/server/test/integration/marketdata.sync-report-digest.it.spec.ts`)。
--
--   ⇒ 消费方**一律读本文件**, **禁止**在 bash / IT / 任何地方内联复制一份 SQL。
--     两份必 drift, 一 drift「判断已被真测」当场变成假话。
--
--   ⚠️ **本文件不是这个脚本的全部判据**: 逐维度图标 / 计数 / 退出码仍在 `.sh` 里(既有债,
--     与 044 零行诊断段委托共享谓词是同一形状: 薄消费留 bash)。**别据此以为脚本已零逻辑。**
--
-- 契约(由 IT 断言锁死): 每维度一行, 恒 10 列 TSV, 顺序为
--   sync_type · status · scanned · ok · skipped · failed · written · started_cst ·
--   unfinished · findings_digest
-- `findings_digest` 单行、无 tab/换行、有长度上限。
--
-- ═══ 为什么会有这个文件: 「写了但没人读」═══
--
-- 旧版这一列的展开条件是 `status NOT IN ('success','skipped')`。而多个写入点**蓄意不计
-- `failed`**(粒度是标的不是行, 用它记行级拒绝会把一票里的一条脏行说成整票失败) ⇒ 那些行恒为
-- `success` ⇒ **写进去等于没写**。
--
-- 2026-08-27 prod 取证: 全表 53 行带真数组明细, **27 行(51%)因此永不展开**; 按 entry 拆
-- `option_snapshot_guard` 41 埋/10 可见、`earnings_instrument_unmatched` 13 埋/**0 可见**、
-- `earnings_date_changed` 11 埋/**0 可见**。被埋的恰好就是那三种「蓄意不计 failed」的 step。
-- #198(违规码) 与 #215(IV 增量失败留痕) 两个修复都因此只完成了「写」那一半。
--
-- ═══ 三个 MUST(每条都有对应的 IT 变异用例)═══
--
--   ① **展开不看 `status`** —— 恒为 success 的行也要出明细, 否则本文件白写。
--   ② **`jsonb_typeof(...) = 'array'` 而非 `IS NOT NULL`** —— 空态存的是 JSON 标量 `null`
--      (`Prisma.JsonNull`), 不是 SQL NULL。prod 实测 749 行如此 ⇒ 用 `IS NOT NULL` 会让每一行
--      空态都打印一个 `null`。
--   ③ **无 `kind` 的历史 entry 归 `legacy` 桶照常展示** —— `kind` 是 #214 才加的, 回填进来的
--      历史 entry 没有它。只认 `kind='...'` 会把上线前的全部明细静默丢掉。
--
-- ═══ digest 的形状与取舍 ═══
--
-- 每维度一串: `kind×N{tokens}` 以 ` · ` 连接, kind 按字母序 ⇒ 输出可确定断言。
-- 每个 kind 取什么 token, 取的是**该 kind 里「不看就判不了」的那一样**:
--
--   | kind                | token                        | 为什么是它 |
--   | ------------------- | ---------------------------- | ---------- |
--   | `reject`            | `symbol` + 违规码(`/` 连)    | 违规码就是 #198 的全部目的 —— 没有它「撞的是哪条门」仍然判不了 |
--   | `skip` / `interrupt`| `reason` 截 40               | 这两种 entry 除了 reason 没有别的内容 |
--   | `failure` / `notice` / `legacy` | `step`           | 见下 |
--
-- 🚨 **`failure` 蓄意只取 `step`, 不带 `error` 原文** —— 这是相对旧版(整段 JSON 截 400 字)的
--    行为变化, 写在明处:
--      · 一轮 60 个失败标的的 error 原文瞬间撑爆任何长度预算, 挤掉本来要被看见的 reject/notice;
--      · 那一行本就带着 `fail=N`, 日报要回答的是「发生了什么类型的事、值不值得我去看」;
--      · 全文一条 psql 就能取(`SELECT findings FROM marketdata.sync_run WHERE id = …`), 没丢。
--    要改回带 error, 改这里 + 补一条 IT, 别在 bash 里加。
--
-- 🚨 窗口 18h **写死在这里不外传参**: 它是阈值不是观测值 —— 传参 = 把判断挪回 bash。
--    (原 `SYNC_REPORT_WINDOW_HOURS` env 旋钮 prod 上从未设置, 随本次下沉一并去掉。)
--    时窗为「滚动 N 小时」而非日历「当日」: tick 22:00 起、报告次晨 09:00 跑, 跨午夜 ⇒「当日」
--    会恒空。18h 回看恰好罩住昨晚 22:00 tick、排除前晚(35h 外)。

WITH latest AS (
  SELECT DISTINCT ON (sync_type) *
  FROM marketdata.sync_run
  WHERE started_at >= now() - interval '18 hours'
  ORDER BY sync_type, started_at DESC
),
entry AS (
  -- 🚨 MUST ②: `jsonb_typeof(...) = 'array'` 而**不是** `IS NOT NULL` —— 空态存的是 JSON 标量
  -- `null`(Prisma.JsonNull), 不是 SQL NULL。写成 IS NOT NULL 会让每一行空态都打印一个 `null`。
  -- 非数组一律折成 '[]' ⇒ 该维度在本 CTE 里零行 ⇒ 下面 LEFT JOIN 给 NULL ⇒ coalesce 成空串。
  SELECT
    l.sync_type,
    -- 🚨 MUST ③: `kind` 是 #214 才加的, 回填进来的历史 entry 没有它 ⇒ 归 `legacy` 桶照常展示。
    -- MUST NOT 按 step 反推 kind: 那是拿字符串匹配伪造一个本来不存在的事实, 猜错了不会报错。
    coalesce(e->>'kind', 'legacy') AS kind,
    CASE coalesce(e->>'kind', 'legacy')
      WHEN 'reject' THEN
        coalesce(e->>'symbol', '?')
        || coalesce(
             ' ' || (SELECT string_agg(v, '/' ORDER BY v)
                     FROM jsonb_array_elements_text(
                       CASE WHEN jsonb_typeof(e->'violations') = 'array'
                            THEN e->'violations' ELSE '[]'::jsonb END) AS v),
             '')
      WHEN 'skip'      THEN left(coalesce(e->>'reason', '?'), 40)
      WHEN 'interrupt' THEN left(coalesce(e->>'reason', '?'), 40)
      ELSE coalesce(e->>'step', '?')
    END AS token
  FROM latest l
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(l.findings) = 'array' THEN l.findings ELSE '[]'::jsonb END
  ) AS e
),
grouped AS (
  SELECT sync_type, kind, count(*) AS n,
         left(string_agg(DISTINCT token, ',' ORDER BY token), 80) AS tokens
  FROM entry
  GROUP BY sync_type, kind
),
digest AS (
  SELECT sync_type,
         string_agg(kind || '×' || n || '{' || tokens || '}', ' · ' ORDER BY kind) AS d
  FROM grouped
  GROUP BY sync_type
)
SELECT
  l.sync_type,
  l.status,
  l.scanned, l.ok, l.skipped, l.failed,
  -- 🚨 NULL **必须**在 SQL 侧换成哨兵: `IFS=$'\t'` 下 tab 属 IFS whitespace ⇒ 连续 tab 折叠成
  -- 一个分隔符 ⇒ psql 输出的 NULL(空字段)当场消失、其后各列静默前移一位。**再加可空列时照此办理。**
  coalesce(l.written::text, 'NULL')                                        AS written,
  to_char(l.started_at AT TIME ZONE 'Asia/Shanghai', 'MM-DD HH24:MI')      AS started_cst,
  (l.finished_at IS NULL)                                                  AS unfinished,
  -- 🚨 MUST ①: **展开不看 `status`** —— 恒为 success 的行也要出明细, 否则本文件白写。
  left(regexp_replace(coalesce(g.d, ''), '[\t\n\r]+', ' ', 'g'), 300)     AS findings_digest
FROM latest l
LEFT JOIN digest g ON g.sync_type = l.sync_type
ORDER BY CASE l.status WHEN 'failed' THEN 0 WHEN 'partial' THEN 1 WHEN 'running' THEN 2
                       WHEN 'success' THEN 3 WHEN 'skipped' THEN 4 ELSE 5 END, l.sync_type;
