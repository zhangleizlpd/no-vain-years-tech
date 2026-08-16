-- 058 研报归档「同标的多版本」: 幂等键放宽 + 新增取号键 (ADR-0065; spec FR-019 / FR-025 / FR-026)。
-- expand-only 且**零行级写、零列改型** —— 本文件只动索引, 既有记录的 version 在结构上没有
--   任何路径能被碰到 (FR-026 / SC-007)。research-058.versioning.it.spec.ts 对本文件做结构断言。
--
-- ⚠️ 本文件**手写**而非 `pnpm db:migrate` 生成: 本机 dev 库 mbw_poc 记录的
--   20260815_2226 checksum 与仓内文件不符 (057 合入前在本机应用过一版), `migrate dev` 因此
--   要求 reset 整个 dev 库 —— 不做。DDL 的正确性由 IT 兜底: 空库 migrate deploy 之后
--   `prisma migrate diff` 对 research_report 零差集 ⇒ 与 prisma 自己会生成的 SQL 等价。
--
-- 幂等键: (uploader_kind, uploader_ref, content_hash) → 含 symbol 的四列。这是**放宽**, 不拒绝
--   任何既有行; 同一份字节归到不同标的从此各自成行, 而 object_key 仍由 content_hash 单独导出
--   ⇒ 对象只存一份 (FR-021)。
-- 取号键: (uploader_kind, uploader_ref, symbol, version)。**不是给查询用的**, 是并发取号
--   (MAX(version)+1 撞 P2002 重试) 的机器保证; 它的最左三列恰是取号查询的过滤列
--   ⇒ 不另建查询索引。

-- DropIndex
DROP INDEX "research"."uk_research_report_uploader_content";

-- CreateIndex
CREATE UNIQUE INDEX "uk_research_report_uploader_symbol_content" ON "research"."research_report"("uploader_kind", "uploader_ref", "symbol", "content_hash");

-- CreateIndex
CREATE UNIQUE INDEX "uk_research_report_version_line" ON "research"."research_report"("uploader_kind", "uploader_ref", "symbol", "version");
