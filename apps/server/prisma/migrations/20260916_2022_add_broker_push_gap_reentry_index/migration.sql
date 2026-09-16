-- 注: prisma migrate dev 误生成的 `DROP INDEX ix_instrument_pinyin_abbr_trgm` 已剔除 —
-- 该 GIN 三元组拼音索引由 raw SQL migration 建 (20260602_1430, prisma schema 表达不了),
-- prisma 不认识非要删它 (本 wrapper scripts/prisma-migrate.ts 自动剔除)。

-- 084 T009 缺口补偿防重入的部分唯一索引 (FR-022; plan D5)。
-- 设计意图 SoT = schema.prisma 的 BrokerSyncRun 段头注释, 此处不镜像字段表。两处易误改:
--   - 谓词**只含 `running`**, 🚫 照抄 `uk_broker_sync_run_reconcile_active` 把 `succeeded` 也纳入
--     —— 断档一天可能合法发生多次, 纳入会让当天第二次断档再也补不回来, 且是静默的
--     (插不进去 = 本拍跳过, 与「已有执行中」同形)。
--   - 谓词**只罩 `kind='gapfill'`**, 🚫 连 `push` 一起罩 —— `push` 是每 5 秒一次的持仓刷新,
--     罩住它会让刷新与补偿互相阻塞, 表现同样是持仓静默不刷新、不报错。
-- 零新表、零改列 (`kind` 是 VARCHAR(16), 新取值放得下), image-only 回滚安全 (旧镜像不写该 kind)。

-- CreateIndex
CREATE UNIQUE INDEX "uk_broker_sync_run_gapfill_active" ON "optionsdesk"."broker_sync_run"("connection_id", "market", "trading_date") WHERE (((kind)::text = 'gapfill'::text) AND ((status)::text = 'running'::text));
