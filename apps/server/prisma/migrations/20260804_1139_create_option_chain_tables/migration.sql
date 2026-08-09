-- 047 optionsdesk M2b 期权链管道的存储地基: marketdata schema 下 3 张新表
-- (期权合约静态属性 / 期权逐日快照 / 财报事件)。
-- expand-only: 仅 CREATE TABLE / CREATE INDEX / ADD FOREIGN KEY, 零破坏性变更 → 单 PR 合规
--   (ADR-0035 + .claude/rules/migration-rules.md §2)。datasource schemas 数组不变 (marketdata
--   已在册), 故无 CREATE SCHEMA。
--
-- 三表全落 **marketdata** 而非 optionsdesk (plan D-ARCH-1 / FR-053): 它们是 vendor 下发的
--   **市场事实**, 与「我给这只票估过值」的自有事实 (optionsdesk.anchor) 不同性质。optionsdesk
--   侧只做 Q7-B 跨 ctx **只读直查** (CROSS-CONTEXT-READ 注释强制, check-server-moat.ts 机器
--   强制), 不搬家、不写。⇒ 三个 model 已在 scripts/checks/check-server-moat.ts 的
--   MODEL_OWNERSHIP 登记为 'marketdata' (漏登记则 optionsdesk 一读就 moat-unmapped 硬拒)。
--
-- option_contract (期权合约静态属性, FR-028) —— 一行 = 一个合约, 唯一 (market, code)。
--   🚫 **不存合约乘数 lot_size** (p3b D5): 非标 (调整后) 合约交割的是「整股 + 零碎股现金找零
--     + 特别现金分配」混合物, 换个乘数并不能让年化 / 有效成本变正确 —— 为 0.56% 且无人成交
--     的合约背一套双轨计算是过度设计。落 is_standard 一个布尔即可; **排除只发生在选约层**,
--     采集端照常全采落库 (证据不可回补, FR-008 / FR-033)。
--   🚫 **不加「是否已到期」状态列** (FR-028a): expiry_date 本身就是权威判据, 再存一份布尔即
--     双写必 drift。已到期合约**永久保留** (快照行指向它, M4 归因要回看已了结的腿)。
--     ⚠️ 两处过滤判据**故意不同, 别统一**: 快照采集工作集 = `expiry_date >= 当前交易日`
--     (当日到期的合约当日仍可取快照, 官方「结束日期请输入今天或未来的日期」); 选约表
--     = `expiry_date > 当前交易日` (已到期腿不可交易)。写成前者只在到期日当天整批假红。
--   option_type 值域含 **CALL** (plan D-DATA-3): 「本片只含认沽」是**呈现面**的话; 采集端
--     option_type = ALL, 因为**快照漏采即永久缺口**, M4 的 wheel / CC 要 CALL 时买不回来。
--
-- option_daily_snapshot (逐日快照, FR-030) —— 幂等键 **(contract_id, session_date, source)**。
--   `source` 第三段**不是纯占位** (FR-040 / plan D-DATA-5): 本片就有两个活值 —— `eod`
--     (收盘后正常采集) 与 `premarket_backfill` (次日盘前兜底, FR-046 ② 级)。第二源 (嘉信)
--     到位时增加值域、不改主键。事后加列要改主键 + 回填, 成本高得多, **必须现在做**。
--   🚨 **三个独立时点列, MUST NOT 合并** (plan D-DATA-4, 本片新发现):
--     · session_date = 本行归属的**交易日** (业务日期按 us 市场时区求值, FR-036)
--     · quote_as_of  = 本行报价**实际采集时刻**
--     · oi_as_of     = **OI 的归属交易日** —— 官方文档明写「美股期权 OI 在**盘前时段**更新」
--       ⇒ T 日收盘后采的快照, 其 OI 其实是 **T−1 日**的持仓量 (OCC/OPRA 固有节奏, 不是 bug);
--       而 FR-046 盘前补采路径拿到的 OI 反而是 T 日真值 ⇒ 两条路径产出的行 OI 年份不同。
--       正常路径 `oi_as_of = 上一交易日`; 盘前补采路径 `oi_as_of = session_date`。
--     🚫 **MUST NOT 为「对齐」把 OI 归到 session_date** —— 那是拿标签掩盖真实 vintage, 盲写
--       **永远不会红**, 但活跃度排名与 UI 的 asOf 全错一天。UI 的 OI 列取 oi_as_of。
--   greeks_complete: 实值区 bid 跌破内在价值 ⇒ IV 无解 ⇒ greeks 缺失是**数学固有现象**不是
--     故障 (实测 227/2150 行、99.5% 是深实值腿), 告警只在虚值区抬 (FR-047 / plan D-ARCH-3)。
--     vendor 缺字段一律 null, **禁 0 冒充** (同 015 端口层契约)。
--   underlying_spot 直取 vendor 随链下发的标的价, **不走复权换算** (ADR-0053 绊线)。
--
-- earnings_event (财报事件, FR-034 + FR-027 PIT) —— 唯一 (instrument_id, earnings_date)。
--   🚨 **其采集维度 MUST NOT 挂锚闸** (FR-035a / plan D-DATA-1): `get_earnings_calendar(US)`
--     是**市场级**接口 (单次 ≤7 天窗返全市场), 调用数只跟前向视野有关、与锚数量无关 ⇒ 锚闸
--     零收窄作用, 挂了只会复刻「零锚时静默不采」那个坑。**判据是「接口是不是 per-code」,
--     不是「维度归属哪一片」** —— 046 已在指数维度上订正过一次同形状问题 (FR-026 → FR-027)。
--   **全市场落库**而非只落白名单: PIT 语义要求连续观察 —— 只落白名单会让建锚前的变更史永久
--     缺失, 且建锚后 first_seen_at 语义直接变错 (成了「建锚那天」)。遇到 Instrument 表外的
--     标的 (新上市 / OTC) → **跳过并计数**保 FK 完整, 该计数作监控信号; MUST NOT 为规避 FK
--     改幂等键。体量 2–8 万条/年, 对 PG 可忽略。
--   PIT 三件套 (first_seen_at / date_changed_at / prev_earnings_date) 自建 —— 业界 confirmed
--     标记只在机构级付费源 (p3b §6.3)。⇒ 每日**重拉整个前向视野**才看得到旧窗里的改动
--     (只拉增量窗永远发现不了「已公布的日期被改了」, FR-034 / plan D-DATA-9)。
--
-- 索引取舍 (除三个幂等唯一键外只加三条, 每条都对应一条真实读路径):
--   · ix_option_contract_underlying_expiry —— 快照工作集与选约表**两条主读路径**都是「某标的
--     + 到期日区间」; 合约永久保留 ⇒ 表随时间单调增长 (12 只锚 × 约 2150 合约/票, 周期权每周
--     新挂), 无索引则 seq scan 随年份线性劣化。
--   · ix_option_daily_snapshot_session_date —— FR-045 的逐合约覆盖率日核对以交易日为入口横扫
--     全表, 而本表是全库增长最快的表 (约 2150 × 12 × 250 ≈ 6.4M 行/年); 唯一键前缀是
--     contract_id, 帮不上以 session_date 为入口的扫描。
--   · ix_earnings_event_date —— FR-034 📌 的「当前覆盖窗右端」判据 (超出右端的到期日 MUST 落
--     「无日期」而非「不跨财报」) 是 max(earnings_date), 每次选约表请求都要求一次。
--   三个幂等唯一键**即幂等语义载体** —— 采集侧 upsert / skipDuplicates 靠它们保证同日重跑零翻倍。
--
-- DDL 由 `pnpm db:migrate` (scripts/prisma-migrate.ts) 从 schema.prisma 生成 (零 drift),
--   wrapper 已自动剔除 diff 误报的 `DROP INDEX ix_instrument_pinyin_abbr_trgm` (pg_trgm GIN
--   索引 schema.prisma 无法建模, 属既有 committed 索引 20260602_1430, 本 migration 不触)。
-- migration_refs: specs/047-optionsdesk-chain-leg-picker (FR-028 合约静态属性 / FR-028a 合约
--   永久保留 / FR-030 逐日快照 / FR-034 财报日历 + PIT / FR-040 来源维度幂等键 / FR-053 三表
--   归 marketdata)

-- CreateTable
CREATE TABLE "marketdata"."option_contract" (
    "id" BIGSERIAL NOT NULL,
    "market" VARCHAR(8) NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "root" VARCHAR(16) NOT NULL,
    "underlying_instrument_id" BIGINT NOT NULL,
    "expiry_date" DATE NOT NULL,
    "strike_price" DECIMAL(18,4) NOT NULL,
    "option_type" VARCHAR(8) NOT NULL,
    "expiration_cycle" VARCHAR(16),
    "settlement_mode" VARCHAR(16),
    "is_standard" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "option_contract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketdata"."option_daily_snapshot" (
    "id" BIGSERIAL NOT NULL,
    "contract_id" BIGINT NOT NULL,
    "session_date" DATE NOT NULL,
    "source" VARCHAR(24) NOT NULL,
    "quote_as_of" TIMESTAMPTZ(6) NOT NULL,
    "oi_as_of" DATE NOT NULL,
    "bid" DECIMAL(18,4),
    "ask" DECIMAL(18,4),
    "bid_size" DECIMAL(20,0),
    "ask_size" DECIMAL(20,0),
    "last" DECIMAL(18,4),
    "prev_close" DECIMAL(18,4),
    "iv" DECIMAL(12,8),
    "delta" DECIMAL(16,8),
    "gamma" DECIMAL(16,8),
    "vega" DECIMAL(16,8),
    "theta" DECIMAL(16,8),
    "rho" DECIMAL(16,8),
    "open_interest" DECIMAL(20,0),
    "net_open_interest" DECIMAL(20,0),
    "volume" DECIMAL(20,0),
    "turnover" DECIMAL(20,2),
    "underlying_spot" DECIMAL(18,4),
    "vendor_update_time" TIMESTAMPTZ(6),
    "greeks_complete" BOOLEAN NOT NULL,

    CONSTRAINT "option_daily_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketdata"."earnings_event" (
    "id" BIGSERIAL NOT NULL,
    "instrument_id" BIGINT NOT NULL,
    "earnings_date" DATE NOT NULL,
    "pub_type" VARCHAR(16) NOT NULL,
    "period_text" VARCHAR(32),
    "eps_actual" DECIMAL(18,6),
    "eps_predict" DECIMAL(18,6),
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "date_changed_at" TIMESTAMPTZ(6),
    "prev_earnings_date" DATE,

    CONSTRAINT "earnings_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ix_option_contract_underlying_expiry" ON "marketdata"."option_contract"("underlying_instrument_id", "expiry_date");

-- CreateIndex
CREATE UNIQUE INDEX "uk_option_contract_market_code" ON "marketdata"."option_contract"("market", "code");

-- CreateIndex
CREATE INDEX "ix_option_daily_snapshot_session_date" ON "marketdata"."option_daily_snapshot"("session_date");

-- CreateIndex
CREATE UNIQUE INDEX "uk_option_daily_snapshot_contract_session_source" ON "marketdata"."option_daily_snapshot"("contract_id", "session_date", "source");

-- CreateIndex
CREATE INDEX "ix_earnings_event_date" ON "marketdata"."earnings_event"("earnings_date");

-- CreateIndex
CREATE UNIQUE INDEX "uk_earnings_event_instrument_date" ON "marketdata"."earnings_event"("instrument_id", "earnings_date");

-- AddForeignKey
ALTER TABLE "marketdata"."option_contract" ADD CONSTRAINT "option_contract_underlying_instrument_id_fkey" FOREIGN KEY ("underlying_instrument_id") REFERENCES "marketdata"."instrument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketdata"."option_daily_snapshot" ADD CONSTRAINT "option_daily_snapshot_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "marketdata"."option_contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketdata"."earnings_event" ADD CONSTRAINT "earnings_event_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "marketdata"."instrument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
