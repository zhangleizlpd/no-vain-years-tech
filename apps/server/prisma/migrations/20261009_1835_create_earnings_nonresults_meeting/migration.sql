-- 079 港股财报日期 · migration ④: marketdata schema 下清单纯股息行表 earnings_nonresults_meeting
--   (spec Session（九）/ FR-006 / FR-017, plan §D3 第 6 项 / §D14)。
-- expand-only: 仅 CREATE TABLE / CREATE UNIQUE INDEX / ADD FOREIGN KEY, 零破坏性变更 → 单 PR 合规
--   (ADR-0035 + .claude/rules/migration-rules.md §2)。marketdata schema 已在册, 无 CREATE SCHEMA。
--
-- 🚨 **本 migration 只含表**: 写入口 (清单来源每日 upsert) 在 T035, 不含任何 seed / 回填 ——
--   清单无历史存档, 表随上线后的每日清单自然积累 (plan §D14「存量」)。
--
-- earnings_nonresults_meeting —— 港交所「董事會會議通知」清单中目的只含股息的行 (纯股息会议)。
--   只供会前通知消歧 (配到只有纯股息行 ⇒ 非业绩会议) 读取; 🚫 进入 earnings_date_observation
--   (合并层会把它当成一期财报生成事件)。唯一键 (instrument_id, meeting_date, purpose):
--   同一会议可列多条纯股息行 (`02402` 2024-04-26「末期股息」+「特別股息」)。
--   model 已在 scripts/checks/check-server-moat.ts 的 MODEL_OWNERSHIP 登记为 'marketdata'。

-- CreateTable
CREATE TABLE "marketdata"."earnings_nonresults_meeting" (
    "id" BIGSERIAL NOT NULL,
    "instrument_id" BIGINT NOT NULL,
    "meeting_date" DATE NOT NULL,
    "purpose" VARCHAR(64) NOT NULL,
    "evidence" VARCHAR(128) NOT NULL,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "earnings_nonresults_meeting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uk_earnings_nonresults_meeting_instrument_date_purpose" ON "marketdata"."earnings_nonresults_meeting"("instrument_id", "meeting_date", "purpose");

-- AddForeignKey
ALTER TABLE "marketdata"."earnings_nonresults_meeting" ADD CONSTRAINT "earnings_nonresults_meeting_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "marketdata"."instrument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
