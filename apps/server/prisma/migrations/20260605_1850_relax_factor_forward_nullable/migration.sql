-- 020 T006 expand 段 (D6 expand→contract 两段时序): factor_forward 改 nullable。
-- 旧写者 (reAdjustBars 链/CLI, 本 PR 内随后退役) 照写兼容; T007 起新跃变锚定只写
-- factor_backward 省略本列。contract 段 (T010) 全仓零消费者后 DROP COLUMN。
ALTER TABLE "marketdata"."adjustment_factor" ALTER COLUMN "factor_forward" DROP NOT NULL;
