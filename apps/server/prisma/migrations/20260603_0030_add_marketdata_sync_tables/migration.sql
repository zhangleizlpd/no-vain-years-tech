-- 016 marketdata 同步配置/审计 3 表 (承接 015 的 6 事实/注册表增量演进)。
-- expand-only: 仅 CREATE TABLE + unique + index + idempotent seed, 非破坏性 → 单 PR
-- 合规 (ADR-0035 + migration-rules.md §2)。
-- datasource schemas 已含 marketdata (015 立), 无需 CREATE SCHEMA。
-- migration_refs: specs/016-marketdata-sync (US1 schema 地基; SyncDimension 配置驱动 /
-- SyncBlacklist 黑名单 / SyncRun 执行审计+水位)。
-- 015 推迟的「无消费者空表」DDL 在此落地 + seed 6 维度默认行 (D3)。

-- CreateTable
CREATE TABLE "marketdata"."sync_dimension" (
    "id" BIGSERIAL NOT NULL,
    "dimension_key" VARCHAR(32) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "cron_expr" VARCHAR(64) NOT NULL,
    "vendor" VARCHAR(32) NOT NULL,
    "market_scope" TEXT[],
    "metrics_list" JSONB,
    "adjust_types" TEXT[],
    "batch_size" INTEGER NOT NULL DEFAULT 50,
    "history_depth" INTEGER,
    "retry_max" INTEGER NOT NULL DEFAULT 3,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "last_watermark" TIMESTAMPTZ(6),
    "paused_until" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_dimension_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketdata"."sync_blacklist" (
    "id" BIGSERIAL NOT NULL,
    "market" VARCHAR(8) NOT NULL,
    "code" VARCHAR(16) NOT NULL,
    "reason" VARCHAR(256) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_blacklist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketdata"."sync_run" (
    "id" BIGSERIAL NOT NULL,
    "sync_type" VARCHAR(32) NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),
    "scanned" INTEGER NOT NULL DEFAULT 0,
    "ok" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "failed_targets" JSONB,
    "status" VARCHAR(16) NOT NULL,

    CONSTRAINT "sync_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uk_sync_dimension_key" ON "marketdata"."sync_dimension"("dimension_key");

-- CreateIndex
CREATE UNIQUE INDEX "uk_sync_blacklist_market_code" ON "marketdata"."sync_blacklist"("market", "code");

-- CreateIndex
CREATE INDEX "ix_sync_run_type_started" ON "marketdata"."sync_run"("sync_type", "started_at" DESC);

-- Seed 6 维度默认行 (D3, idempotent ON CONFLICT DO NOTHING — 重 deploy / 多环境安全)。
-- cron_expr 默认 22:00 (D4, F7 经验测后改配置不改代码); universe 走东财 clist, 其余走理杏仁。
-- priority 大者先消费 (universe→profile→eod→fundamental→financial→corp-action); adjust_types
-- 仅 eod_bar 需三复权口径 (FR-S06)。metrics_list/history_depth 留 NULL (维度形态各异, 后续配)。
INSERT INTO "marketdata"."sync_dimension"
  ("dimension_key", "enabled", "cron_expr", "vendor", "market_scope", "adjust_types", "batch_size", "priority")
VALUES
  ('universe',         true, '0 0 22 * * *', 'eastmoney', '{cn}'::text[], '{}'::text[],                      200, 10),
  ('profile',          true, '0 0 22 * * *', 'lixinger',  '{cn}'::text[], '{}'::text[],                       50,  9),
  ('eod_bar',          true, '0 0 22 * * *', 'lixinger',  '{cn}'::text[], '{none,forward,backward}'::text[],   1,  8),
  ('fundamental',      true, '0 0 22 * * *', 'lixinger',  '{cn}'::text[], '{}'::text[],                        1,  7),
  ('financial',        true, '0 0 22 * * *', 'lixinger',  '{cn}'::text[], '{}'::text[],                        1,  6),
  ('corporate_action', true, '0 0 22 * * *', 'lixinger',  '{cn}'::text[], '{}'::text[],                        1,  5)
ON CONFLICT ("dimension_key") DO NOTHING;
