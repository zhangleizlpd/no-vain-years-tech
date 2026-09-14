-- 079 T016 港股财报日期维度 seed + 两条依赖边 (FR-007 / FR-023 / FR-024, plan §D9)。**纯 seed, 无 DDL**
-- —— 四张表与财年档案表早由 20260913_2220 / 20260913_2321 建好。
--
-- 🚨 与全部注册触点**同 commit** (排序铁律 1): 先落本 seed 会让 tick 触发一个没有执行器的维度
--   (`runDimension` throw), 且写死维度清单的 IT 在中间 commit 变红。
--
-- ══ 为什么是独立维度, 而不是给 `earnings_event` 的 market_scope 加 'hk' ═══════════════════
-- `session-clock.ts` 的 `exchangeCalendarDateForScope` 在 scope 内各市场算出的日历日不同时
--   **直接 throw** (北京 06:00 时 us = D-1 而 hk = D) —— 与 20260823_1015 拆港股期权三行同一条理由。
--
-- ── 取值 ─────────────────────────────────────────────────────────────────────────────
-- `cron '0 30 23 * * *'` (Asia/Shanghai): 来源 B (交易所公告) 读的是 `announcement` 维度**当天**
--   已采的行, 必须排在它 22:00 那一拍之后 (plan §D9)。断言是**机械的**, 在
--   test/integration/marketdata-079.schema.it.spec.ts: 解析两行 cron_expr, 断本行下一触发晚于
--   同日 `announcement` 那一拍、早于次日 00:00 —— 写死字符串比对会在有人改 cron 时静默放行。
-- `queue_lane = 'futu'`: 三个来源里唯一走共享限频的是富途财报日历 ⇒ 必须登记 futu lane
--   (20260827_1817), 漏登记会落回 default lane 与理杏仁夜间链排队。
-- `vendor = 'futu'` 只是标注; **代码从不读取该列** (见 schema.prisma 该列注释)。
-- `batch_size = 1` / `history_depth` NULL: 执行器不按标的分批、不读回填深度 —— 日常 / 回填窗口
--   是各来源代码里的常量 (公告刊发事实 7 天 / 会前通知 120 天 / 回填 730 天), 不来自维度行。
--   形态同 `earnings_event` 那行 (20260804_1155)。
-- `priority = 1`: 与上游 `announcement` 同档。它不在任何 hard 边上, 且两条入边都是 soft ⇒ 在
--   派生全序里要等 `announcement` 出队才进 ready 集, 插不进任何 hard 边中间。守卫在
--   dimension-executor.spec.ts「079 T016」块。
-- `freshness_profile` / `sla_hours` 同 047 / 066 / 073 各行。
-- `next_fire_at` 不写 (列默认 NULL): tick 首拍按 cron 懒初始化, 不会立即补跑。
--
-- 🚫 **不进 `ANCHOR_SCOPED_DIMENSIONS`** (排序铁律 2): 工作集不是标的集 (富途市场级窗 / 本 ctx
--   公告表 / 清单整页), 挂锚闸只会复刻「零锚时静默不采」。反向断言在
--   anchor-scoped-dimensions.rules.spec.ts。
--
-- migration_refs: specs/079-hk-earnings-date-sources (FR-007 / FR-023 / FR-024)

INSERT INTO "marketdata"."sync_dimension"
  ("dimension_key", "enabled", "cron_expr", "vendor", "queue_lane", "market_scope",
   "adjust_types", "batch_size", "history_depth", "retry_max", "priority",
   "freshness_profile", "sla_hours")
VALUES
  ('hk_earnings_date', true, '0 30 23 * * *', 'futu', 'futu', '{hk}'::text[],
   '{none}'::text[], 1, NULL, 3, 1, 'continuous-daily', 26)
ON CONFLICT ("dimension_key") DO NOTHING;

-- 两条 **soft** 边 (plan §D9): 只定执行序、不构成工作集闸, 上游缺席 / 失败不拖垮本维度 ——
-- 富途与清单两个来源不依赖它们, 公告来源在 `announcement` 失败时照读已有行 (刊发事实窗口 7 天)。
-- ⚠️ 日常 tick 里两个上游都在 22:00、本维度在 23:30, 不同 tick ⇒ 这两条边只在**同一 flow**
--   (回填 CLI 全维度) 里装配; 日常的先后靠 cron 表达, 由上面那条机械断言守。
INSERT INTO "marketdata"."sync_dependency" ("upstream", "downstream", "mode")
VALUES
  ('universe', 'hk_earnings_date', 'soft'),
  ('announcement', 'hk_earnings_date', 'soft')
ON CONFLICT ("upstream", "downstream") DO NOTHING;
