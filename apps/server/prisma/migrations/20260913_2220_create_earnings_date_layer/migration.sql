-- 079 港股财报日期多源采集与确认层 · migration ①: marketdata schema 下 4 张新表 (plan §D3)。
-- expand-only: 仅 CREATE TABLE / CREATE INDEX / ADD FOREIGN KEY, 零破坏性变更 → 单 PR 合规
--   (ADR-0035 + .claude/rules/migration-rules.md §2)。marketdata schema 已在册, 无 CREATE SCHEMA。
--
-- 🚨 **本 migration 只含表** (tasks 排序铁律 1): `hk_earnings_date` 维度 seed + 依赖边是
--   migration ②, 与全部注册触点同 commit (T016)。先落 seed 会让写死维度清单的 IT 在中间
--   commit 变红, 也会让 tick 触发一个没有执行器的维度。
--
-- 🚫 **不复用 earnings_event** (D1 / FR-021), 🚫 不给 optionsdesk 任何读口 (FR-022): 期权台读
--   财报日期只读 earnings_event 且不按市场过滤 ⇒ 本层 4 表对它不可见是结构保证。
--   4 个 model 已在 scripts/checks/check-server-moat.ts 的 MODEL_OWNERSHIP 登记为 'marketdata'。
--
-- earnings_date_observation (来源观测, PIT) —— 唯一 (source, instrument_id, period_key)。
--   period_key 非空三形态 `P:` / `T:` / `D:` (构造单点 earnings-period.rules.ts); 非空才能让
--   唯一键真去重 (PG 视多个 NULL 互异)。另建 (instrument_id, period_key): 合并读路径是「某
--   (标的, 期) 的全部来源观测」, 唯一键以 source 打头用不上。
-- earnings_date_event (合并后事件) —— 唯一 (instrument_id, period_key); revision 乐观并发列。
-- earnings_date_event_log (事件流水, append-only) —— 无业务唯一键; (event_id, created_at) 服务
--   「某事件的变更史」读取。
-- earnings_meeting_lag (会议 → 刊发间隔) —— 唯一 (instrument_id, report_kind), 只存最近一次。
--
-- 值域列 (source / basis / status / confirmed_basis / report_kind / kind) 无 DB 侧 enum/CHECK ——
--   同 sync_run.status 的取舍, 值域单一来源在 TS 类型, 加值零 migration。

-- CreateTable
CREATE TABLE "marketdata"."earnings_date_observation" (
    "id" BIGSERIAL NOT NULL,
    "source" VARCHAR(32) NOT NULL,
    "instrument_id" BIGINT NOT NULL,
    "period_key" VARCHAR(128) NOT NULL,
    "market" VARCHAR(8) NOT NULL,
    "report_kind" VARCHAR(16),
    "period_end" DATE,
    "period_text" VARCHAR(128),
    "basis" VARCHAR(16) NOT NULL,
    "announce_date" DATE,
    "meeting_date" DATE,
    "publication_time" TIMESTAMPTZ(6),
    "filed_date" DATE,
    "evidence" VARCHAR(512),
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "prev_date" DATE,
    "date_changed_at" TIMESTAMPTZ(6),
    "deviation_days" INTEGER,

    CONSTRAINT "earnings_date_observation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketdata"."earnings_date_event" (
    "id" BIGSERIAL NOT NULL,
    "instrument_id" BIGINT NOT NULL,
    "period_key" VARCHAR(128) NOT NULL,
    "market" VARCHAR(8) NOT NULL,
    "report_kind" VARCHAR(16),
    "period_end" DATE,
    "status" VARCHAR(24) NOT NULL,
    "announce_date" DATE,
    "announce_basis" VARCHAR(16),
    "conflict_candidates" JSONB,
    "publication_time" TIMESTAMPTZ(6),
    "confirmed_date" DATE,
    "confirmed_basis" VARCHAR(16),
    "sources" TEXT[],
    "overdue_since" TIMESTAMPTZ(6),
    "revision" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "earnings_date_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketdata"."earnings_date_event_log" (
    "id" BIGSERIAL NOT NULL,
    "event_id" BIGINT NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "from_status" VARCHAR(24),
    "to_status" VARCHAR(24),
    "detail" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "earnings_date_event_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketdata"."earnings_meeting_lag" (
    "id" BIGSERIAL NOT NULL,
    "instrument_id" BIGINT NOT NULL,
    "report_kind" VARCHAR(16) NOT NULL,
    "lag_days" INTEGER NOT NULL,
    "period_end" DATE,
    "observed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "earnings_meeting_lag_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ix_earnings_date_observation_instrument_period" ON "marketdata"."earnings_date_observation"("instrument_id", "period_key");

-- CreateIndex
CREATE UNIQUE INDEX "uk_earnings_date_observation_source_instrument_period" ON "marketdata"."earnings_date_observation"("source", "instrument_id", "period_key");

-- CreateIndex
CREATE UNIQUE INDEX "uk_earnings_date_event_instrument_period" ON "marketdata"."earnings_date_event"("instrument_id", "period_key");

-- CreateIndex
CREATE INDEX "ix_earnings_date_event_log_event_created" ON "marketdata"."earnings_date_event_log"("event_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "uk_earnings_meeting_lag_instrument_kind" ON "marketdata"."earnings_meeting_lag"("instrument_id", "report_kind");

-- AddForeignKey
ALTER TABLE "marketdata"."earnings_date_observation" ADD CONSTRAINT "earnings_date_observation_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "marketdata"."instrument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketdata"."earnings_date_event" ADD CONSTRAINT "earnings_date_event_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "marketdata"."instrument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketdata"."earnings_date_event_log" ADD CONSTRAINT "earnings_date_event_log_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "marketdata"."earnings_date_event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketdata"."earnings_meeting_lag" ADD CONSTRAINT "earnings_meeting_lag_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "marketdata"."instrument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
