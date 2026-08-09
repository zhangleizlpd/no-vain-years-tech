-- 023 alert_condition 带参条件改造 (plan D3, 无不可逆操作):
-- type 列宽 16→32 (容 DIVIDEND_YIELD_ABOVE 等 023 词表); param sentinel 0 = 无参;
-- threshold 转 nullable (穿越/无参类条件禁带); 唯一约束 (alert_id, type) →
-- (alert_id, type, param) 纯放宽 — 021 存量行 param 默认 0 即正确语义, 零数据迁移。

-- AlterTable
ALTER TABLE "alert"."alert_condition" ALTER COLUMN "type" SET DATA TYPE VARCHAR(32);
ALTER TABLE "alert"."alert_condition" ADD COLUMN "param" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "alert"."alert_condition" ALTER COLUMN "threshold" DROP NOT NULL;

-- DropIndex
DROP INDEX "alert"."uk_alert_condition_alert_type";

-- CreateIndex
CREATE UNIQUE INDEX "uk_alert_condition_alert_type_param" ON "alert"."alert_condition"("alert_id", "type", "param");
