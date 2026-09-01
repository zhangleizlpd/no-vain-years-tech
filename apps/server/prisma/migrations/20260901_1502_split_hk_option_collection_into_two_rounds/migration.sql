-- 073 港股期权采集拆两轮: 主轮前移到收盘直后 16:20 抢报价 + 新增轮2 21:40 回填定稿后的 OI。
-- 纯 data-only (UPDATE + 幂等 INSERT), 无 DDL → 单 PR 合规 (ADR-0035 + migration-rules.md §2)。
--
-- ══ 病根: 采集时刻落在做市商撤单后的最差台阶上 ═══════════════════════════════════════
-- 港股期权整轮采集原先排在 23:00 = **收盘 7 小时后**, 而做市商盘口在收盘后是**阶梯式**撤走的。
-- 2026-08-31 探针实测 (28 个港股锚, 网格 15:30→22:47): 收租召回集在 23:00 那一档
--   **45.2% 的腿拿不到买价**, 而同一批腿在收盘后那半小时只有 **11.5%** 缺价。
-- ⇒ 报价要尽早采, 但 OI 要等清算侧 21:30 定稿 (`MARKET_OI_SETTLE_LOCAL_MINUTE.hk`)。
--   一轮打包只能二选一 ⇒ 拆两轮, 各自排在自己那件事的最优时刻。
--
-- ══ 主轮为什么是 16:20 (上下界都是硬的) ═══════════════════════════════════════════════
-- 下界 = **收盘定稿缓冲解除**: HKEX CAS 16:08–16:10 随机收市, 官方收盘价最早 16:10 才存在
--   (`CLOSE_SETTLE_BUFFER_MINUTES.hk = 10`)。早于它写入会被 `isCloseWriteBlocked` 挡下 ——
--   那道闸不是装饰, 它防的是「把未定稿的盘中价当成收盘价落库」。
--   🚫 **别为了多抢余量改成 16:12**: 只剩 2 分钟, CAS 随机收市延后即踩闸。
-- 上界 = 盘口台阶的上界 (样本期结论, 单点常量登记在 `market-session.rules.ts`, 073 T009)。
-- 🚨 三个维度**同一拍**触发, MUST NOT 靠 cron 错峰分开 —— ADR-0049 §3 的依赖边只在**同一
--   tick 内共同触发**的维度之间装配, 错峰 = 边直接失效, 正是 20260827_1957 花一整条 migration
--   修掉的形态。链发现先于快照由**依赖边 + 同 priority 下的字典序**保证
--   ('hk_option_contract' < 'hk_option_daily_snapshot'), 不靠时刻先后。
--
-- ══ 🚨 改 cron_expr MUST 同条 migration 置 next_fire_at = NULL ═══════════════════════
-- 先例与完整论证见 20260827_2112 (它整条 migration 就是为补 20260827_1957 漏掉的这一半)。
-- 漏了的表现是「改动**静默滞后一个周期**」: `next_fire_at` 是 cron 的物化值, 只在该行触发时
-- 才重算 ⇒ 不置 NULL 的话那一行下一次**仍按旧时刻触发**, 而一切看起来正常 (无报错、cron 列
-- 也确实是新值)。置 NULL 走 claim 分支 (a): 按当前 cron 物化成 from-now 的下一触发, **本轮
-- 不入队** (无 surprise 补跑)。
--
-- ══ 🚨 轮2 **刻意不连依赖边** —— 这是裁决, 不是遗漏 ═══════════════════════════════════
-- 直觉上该连一条 `hk_option_daily_snapshot → hk_option_oi_settle`, 但两者在**不同 tick**
-- (16:20 vs 21:40), 而 ADR-0049 §3 的边只在同一 tick 内装配 ⇒ 连了是一条**永远装不上、
-- 却看起来像保证**的空话。轮2 对主轮的依赖靠**数据**表达: 主轮没写行 ⇒ 轮2 走段 b 补漏
-- (`sync-option-oi-settle.usecase.ts`), 不靠调度图。
-- 🚫 将来有人想「顺手把这条边补上」⇒ 先回去读 20260827_1957: 那条 migration 存在的全部理由
--    就是删掉两条从上线至今一次都没装配过的 hard 边。
--
-- ══ 沿革留痕: 20260827_1957 的一条前提已失效, 但它的结论仍成立 ═══════════════════════
-- 那条 migration 把港股 `hk_option_contract → hk_option_daily_snapshot` 从 hard 降 soft,
-- 论证的核心前提是「港股**零补救**」(`US_MARKET_SCOPE = ['us']` 无港股对应物)。
-- 🚨 该前提已于 2026-08-28 (#265) 失效 —— 港股两级补救那时已上线。
-- **但结论不变**: 仍然不把那条边改回 hard。理由换成更强的一条 —— 本片起轮2 自带段 b 补漏,
-- 且它的档位**严格优于**当初那两级 (同日、同 session、同 source, 不留 premarket_backfill 痕)。
-- 🚫 **MUST NOT 回去改 20260827_1957 的注释** —— 已应用的 migration 改注释会炸 Prisma
--    checksum (成例: `market-session.rules.ts:166` 对 20260825_1910 的同款处理)。从那句话
--    grep 过来的人落在这里。`sync_dependency.mode` 本片一个字不动。
--
-- ══ 轮2 那一行的取值逐条 ═════════════════════════════════════════════════════════════
-- `cron '0 40 21 * * *'` —— OI 定稿时刻 21:30 之后留 10 分钟余量。🚨 时刻**不是**正确性的
--   来源: use case 起手调 `oiRefreshedAtEod` 判据, 判据为假整轮不写 (plan §D3)。cron 只是
--   「大多数时候不用走那条 skip」的调度选择。
-- `batch_size = 400` 同 `hk_option_daily_snapshot`: get_option_snapshot 官方批量上限。
-- `history_depth` 留 NULL: 期权快照**无跨日补救** (vendor 不提供历史交易日的期权快照) ⇒
--   本维度没有 backfill 语义, 同主轮。
-- `priority = 5` 同港股其余三行。它与主轮**不在同一 tick**, 故 priority 对两轮之间的顺序
--   没有任何作用 —— 填 5 只是与同族保持一致, 别读成「它排在谁后面」。
-- `queue_lane = 'futu'` —— 打 futu shim 的维度必须登记 (20260827_1817), 漏登记会落回
--   default lane 与理杏仁那条夜间链排队。
-- `enabled = true` 上线即开: 与 066 那次 `hk_option_daily_snapshot` seed 成 false 的理由
--   **不同** —— 那次是 OI 归属日尚在实测、开了会静默写错标签; 本片的归属判据已在代码里落地
--   且有单测钉住, 不存在「开了会写脏」的窗口。
-- `vendor = 'futu'` 仅记录建表意图; **代码从不读取该列** (见 schema.prisma 该列注释)。
--
-- ══ 回滚 ═════════════════════════════════════════════════════════════════════════════
-- 反向 SQL (不写进本文件, 走 runbook 手工执行):
--   UPDATE sync_dimension SET enabled = false, next_fire_at = NULL
--    WHERE dimension_key = 'hk_option_oi_settle';
--   UPDATE sync_dimension SET cron_expr = '0 0 23 * * *', next_fire_at = NULL
--    WHERE dimension_key IN ('hk_option_contract', 'hk_option_daily_snapshot');
-- 🚨 回滚**不删**轮2 那一行: `DIMENSION_KEYS` 与 seed 行数有机器不变式对拍
--   (marketdata.sync-schema-gate.it.spec.ts), 删行会让 IT 门在旧镜像上红。关 `enabled` 即可。
--
-- 📌 `hk_underlying_iv_daily` **本条不动**, 仍留 23:00 —— 它的前移是条件项 (073 FR-017/T013),
--    前提是「16:2x 那个读数已定型」, 而该字段 vendor 侧**盘中分钟级更新**
--    (`underlying-iv.rules.ts` 自陈)。探针 2026-09-01 起跑, 结论落地前不动它。
--    ⚠️ 本 migration 一旦在任何环境应用过, T013 的前移**MUST 另开一条** (改已应用的
--    migration 会炸 checksum)。
--
-- migration_refs: specs/073-hk-option-two-round-collection (FR-001…FR-005 主轮前移 /
--   FR-006 轮2 新维度 / FR-012 next_fire_at 复位 / FR-016 沿革留痕); issue #308

-- ① 主轮两个维度前移到 16:20 (IV 那行见文件末的 📌)。
UPDATE "marketdata"."sync_dimension"
   SET "cron_expr" = '0 20 16 * * *', "updated_at" = now()
 WHERE "dimension_key" IN ('hk_option_contract', 'hk_option_daily_snapshot');

-- ② 同条 migration 复位物化值, 否则改动静默滞后一个周期 (见上文)。
UPDATE "marketdata"."sync_dimension"
   SET "next_fire_at" = NULL
 WHERE "dimension_key" IN ('hk_option_contract', 'hk_option_daily_snapshot');

-- ③ 轮2 维度行。幂等 (ON CONFLICT DO NOTHING, 同 20260823_1015 体例)。
INSERT INTO "marketdata"."sync_dimension"
  ("dimension_key", "enabled", "cron_expr", "vendor", "queue_lane", "market_scope",
   "adjust_types", "batch_size", "history_depth", "retry_max", "priority",
   "freshness_profile", "sla_hours")
VALUES
  ('hk_option_oi_settle', true, '0 40 21 * * *', 'futu', 'futu', '{hk}'::text[],
   '{none}'::text[], 400, NULL, 3, 5, 'continuous-daily', 26)
ON CONFLICT ("dimension_key") DO NOTHING;
