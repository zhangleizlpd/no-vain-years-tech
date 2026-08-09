-- 046 optionsdesk M2a 自建两条标的级数据管道的存储地基: marketdata schema 下 3 张新表
-- (标的级 IV 日快照 / 标的级 IV 历史序列 / 美股波动率指数日线)。
-- expand-only: 仅 CREATE TABLE / CREATE INDEX / ADD FOREIGN KEY, 零破坏性变更 → 单 PR 合规
--   (ADR-0035 + .claude/rules/migration-rules.md §2)。datasource schemas 数组不变 (marketdata
--   已在册), 故无 CREATE SCHEMA。
--
-- 三表全落 **marketdata**(市场事实, p3b §4.5) 而非 optionsdesk: 它们是 vendor 下发的市场
--   事实, 与「我给这只票估过值」的自有事实 (optionsdesk.anchor) 不同性质。optionsdesk 的两个
--   读端只做 Q7-B 跨 ctx **只读直查** (CROSS-CONTEXT-READ 注释强制), 不搬家、不写。
--
-- underlying_iv_daily (标的级 IV 日快照) = 富途 `get_option_underlying_overview` 批量直读的
--   当日结论, **UI 读的就是这张表** (显示口径单源 = 直读值, FR-035)。iv/hv_* 按 vendor 原样
--   存百分数 (实测 25.5 = 25.5%), 落库不二次换算; 分位列值域 0-100; 缺字段一律 null 禁 0 冒充。
--   ⚠️ iv_rank (IVR) 只落库不上屏 (FR-013) —— 采集端全开、过滤放呈现端。
--
-- underlying_iv_history (标的级 IV 历史序列) = `get_option_underlying_his_volatility` 回填的
--   **原始序列**, 只供 IVP 自算与双算对表 (FR-034 / plan D4), 不上屏。
--   🚨 **与日快照分两张表是刻意的** (plan D5): ① 采集节奏不同 (日快照日更增量; 历史序列首次
--   拉满 vendor 上限约 3 年 —— 那是**滑动窗**, 今天不拉明年那段就永久没了, FR-024 —— 之后只做
--   尾部增量) ② 前者是 **vendor 结论**、后者是**原始序列**, 混表会糊掉「直读 vs 自算」的来源
--   边界, 而那正是双算对表要监控的东西 (富途聚合规则未文档化, 它若改规则这是唯一信号)。
--
-- us_index_daily (美股波动率指数日线) = VIX / VVIX, 源 = **CBOE 官方历史 CSV** (77 直连, 全量
--   文件 upsert ⇒ 幂等天然成立, delta_lookback_days 那套不适用)。
--   🚨 **禁接 CBOE 盘中报价端点** `delayed_quotes/quotes/*.json`: 站点级 Terms 明文禁复制/存储
--   进电子检索系统, 官方免费的只有历史文件 (p3b E1/E24)。
--   🚨 **VVIX 只有 CLOSE 一列** (E2 实测表头 `DATE,VVIX`) ⇒ open/high/low **nullable 禁填 0**
--   (FR-025): 填 0 会让「VVIX 开盘 0」这种假事实进库, 下游再也分不出「无此列」与「真是 0」。
--   无 instrument 关联且**采集不挂锚闸** (FR-027 / plan D1): 富途与东财均不收录这两个代码
--   (p3b E4/E26) ⇒ 库里根本不存在对应 Instrument 行; 工作集 = 两个固定代码常量, 零锚照常跑
--   (「指数表盘不依赖锚」, 挂了闸零锚时会静默不跑并与 FR-018 空态分支直接矛盾)。
--
-- 三个唯一键 (instrument_id, date) × 2 + (index_code, date) **即幂等语义载体** —— 采集侧
--   upsert / skipDuplicates 靠它们保证同日重跑零翻倍 (T005 IT 以「重复插撞 P2002」固化)。
--   不另建时序索引: 唯一索引本身即 (键, date) B-tree, 反向扫描已服务「取最近一期」与「按标的
--   取整段序列」两种读形态; 三表规模上限 = 12 只锚 × 3 年 + 指数 2 × 36 年, 多余索引是净噪声。
--
-- DDL 由 `prisma migrate diff --from-config-datasource --to-schema` 从 schema.prisma 生成 (零 drift),
--   剔除 diff 误报的 `DROP INDEX ix_instrument_pinyin_abbr_trgm` (pg_trgm GIN 索引 schema.prisma
--   无法建模, 属既有 committed 索引 20260602_1430, 本 migration 不触 — 同 043/044/045 先例)。
-- migration_refs: specs/046-optionsdesk-detail-thermometer

-- CreateTable
CREATE TABLE "marketdata"."underlying_iv_daily" (
    "id" BIGSERIAL NOT NULL,
    "instrument_id" BIGINT NOT NULL,
    "date" DATE NOT NULL,
    "iv" DECIMAL(12,8),
    "iv_rank" DECIMAL(8,4),
    "iv_percentile" DECIMAL(8,4),
    "pre_iv" DECIMAL(12,8),
    "hv_30" DECIMAL(12,8),
    "hv_30_percentile" DECIMAL(8,4),
    "hv_60" DECIMAL(12,8),
    "hv_60_percentile" DECIMAL(8,4),
    "hv_90" DECIMAL(12,8),
    "hv_90_percentile" DECIMAL(8,4),
    "hv_120" DECIMAL(12,8),
    "hv_120_percentile" DECIMAL(8,4),
    "hv_365" DECIMAL(12,8),
    "hv_365_percentile" DECIMAL(8,4),
    "call_volume" DECIMAL(20,0),
    "put_volume" DECIMAL(20,0),
    "call_oi" DECIMAL(20,0),
    "put_oi" DECIMAL(20,0),

    CONSTRAINT "underlying_iv_daily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketdata"."underlying_iv_history" (
    "id" BIGSERIAL NOT NULL,
    "instrument_id" BIGINT NOT NULL,
    "date" DATE NOT NULL,
    "iv" DECIMAL(12,8),
    "hv" DECIMAL(12,8),
    "underlying_price" DECIMAL(18,4),

    CONSTRAINT "underlying_iv_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketdata"."us_index_daily" (
    "id" BIGSERIAL NOT NULL,
    "index_code" VARCHAR(16) NOT NULL,
    "date" DATE NOT NULL,
    "open" DECIMAL(18,4),
    "high" DECIMAL(18,4),
    "low" DECIMAL(18,4),
    "close" DECIMAL(18,4) NOT NULL,

    CONSTRAINT "us_index_daily_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uk_underlying_iv_daily_instrument_date" ON "marketdata"."underlying_iv_daily"("instrument_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "uk_underlying_iv_history_instrument_date" ON "marketdata"."underlying_iv_history"("instrument_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "uk_us_index_daily_code_date" ON "marketdata"."us_index_daily"("index_code", "date");

-- AddForeignKey
ALTER TABLE "marketdata"."underlying_iv_daily" ADD CONSTRAINT "underlying_iv_daily_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "marketdata"."instrument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketdata"."underlying_iv_history" ADD CONSTRAINT "underlying_iv_history_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "marketdata"."instrument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
