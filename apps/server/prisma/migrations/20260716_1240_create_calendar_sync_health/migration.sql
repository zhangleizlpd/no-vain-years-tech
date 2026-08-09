-- 044 交易日历填充心跳表 (per-market 一行, 市场级非标的级 → 无 instrument FK)。
-- 取代「per-market catch 只 WARN + inserted:0 续跑」的静默降级 (044 事故: 日历填充停摆潜伏 2 天):
--   成功 → last_success_at + served_by; 失败 → last_attempt_at + last_error (不动 last_success_at)
--   → 心跳陈旧 → ops/marketdata-calendar-health 探针直读 PG 告警 (不经 app 进程, FR-010)。
-- served_by = 降级可观测载体 (FR-014): 记本次成功由链上哪层服务 ('tencent'/'static')。
--   非主源 → 降级运行 → 告警 (降级 ≠ 健康: 系统虽在工作但已失去冗余, L2 仅当年 + 仅 cn/hk);
--   主源恢复 → 值变回主源 → 信号自动解除。
-- 不复用 sync_run: 其语义是「维度同步跑批审计」, 日历填充不是维度 (不在 DIMENSION_KEYS 里),
--   塞非维度行会污染 report.sh 逐维度解析 + 全景 IT 维度计数断言 (plan Decision 5)。
-- expand-only: 仅 1 CREATE TABLE, 非破坏性 → 单 PR 合规 (ADR-0035 + migration-rules.md §2)。
--   datasource schemas 已含 marketdata (015 立), 无需 CREATE SCHEMA。
-- DDL 由 `prisma migrate diff --from-config-datasource --to-schema` 从 schema.prisma 生成 (零 drift),
--   剔除 diff 误报的 `DROP INDEX ix_instrument_pinyin_abbr_trgm` (pg_trgm GIN 索引 schema.prisma 无法建模,
--   属既有 committed 索引 20260602_1430, 本 migration 不触 — 同 043 先例)。
-- migration_refs: specs/044-marketdata-calendar-resilience (US3 心跳告警 / FR-008 失败不再静默吞 /
--   FR-010 探针不经 app / FR-014 降级可观测)。

-- CreateTable
CREATE TABLE "marketdata"."calendar_sync_health" (
    "market" VARCHAR(8) NOT NULL,
    "last_success_at" TIMESTAMP(3),
    "last_attempt_at" TIMESTAMP(3),
    "last_error" TEXT,
    "served_by" VARCHAR(16),

    CONSTRAINT "calendar_sync_health_pkey" PRIMARY KEY ("market")
);
