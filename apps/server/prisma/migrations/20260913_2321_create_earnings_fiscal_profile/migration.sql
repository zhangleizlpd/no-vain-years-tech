-- 079 港股财报日期 · migration ③: marketdata schema 下财年档案表 earnings_fiscal_profile (plan §D3 第 5 项 / §D13)。
-- expand-only: 仅 CREATE TABLE / CREATE UNIQUE INDEX / ADD FOREIGN KEY, 零破坏性变更 → 单 PR 合规
--   (ADR-0035 + .claude/rules/migration-rules.md §2)。marketdata schema 已在册, 无 CREATE SCHEMA。
--
-- 🚨 **本 migration 只含表**: 写入口 (反推用例 / 人工补录 CLI) 在 T029, 不含任何 seed。
--
-- earnings_fiscal_profile (财年档案, FR-026) —— 唯一 instrument_id: 每只标的至多一行,
--   **没有行 = 财年未知** (MUST NOT 按 12 月结年代入, FR-026 / FR-027)。
--
-- 值域列 (source / fiscal_year_end_month) 无 DB 侧 enum/CHECK —— 同 migration ① 四表与 sync_run.status
--   的取舍, 值域单一来源在 TS (`earnings-fiscal-profile.rules.ts` 的 FiscalProfileSource), 加值零 migration。
--   model 已在 scripts/checks/check-server-moat.ts 的 MODEL_OWNERSHIP 登记为 'marketdata'。

-- CreateTable
CREATE TABLE "marketdata"."earnings_fiscal_profile" (
    "id" BIGSERIAL NOT NULL,
    "instrument_id" BIGINT NOT NULL,
    "fiscal_year_end_month" SMALLINT NOT NULL,
    "source" VARCHAR(16) NOT NULL,
    "evidence" TEXT NOT NULL,
    "determined_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "earnings_fiscal_profile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uk_earnings_fiscal_profile_instrument" ON "marketdata"."earnings_fiscal_profile"("instrument_id");

-- AddForeignKey
ALTER TABLE "marketdata"."earnings_fiscal_profile" ADD CONSTRAINT "earnings_fiscal_profile_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "marketdata"."instrument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
