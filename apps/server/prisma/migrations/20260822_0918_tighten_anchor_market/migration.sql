-- 065 雷达按市场分页签 · **contract 步** (T03): `optionsdesk.anchor.market` 收紧为 NOT NULL +
-- 值域 CHECK。本 migration **单独部署一次**, MUST NOT 与 T01 的 expand 步合并。
--
-- ## 为什么必须是两个 migration
--
-- prod 回滚只换镜像 tag、**不回退 DB schema** (ops/runbook/prod-deploy-rollback.md)。若把加列与
-- 收紧写进同一个 migration, 回滚到「不写 market 列」的旧镜像后, 每一次建锚 INSERT 都会因 NOT NULL
-- 而失败 —— 脏回滚。拆开之后, 回滚到「写 market 的 T02 镜像」始终安全。
--
-- ## 前置条件 (不满足则本 migration 必须失败, 而不是绕过)
--
-- T01 的一次性回填要已覆盖**全部**既有行。取证 (2026-08-21, 判据 = `anchor.rules.ts` 的
-- `parseAnchorTicker`): prod 16 行全部 well-formed `us:*`、0 畸形; dev 12 行同形 ⇒ 回填 100%
-- 覆盖、零残留 NULL。若某库存在 ticker 解析不出 `market:code` 的行 (冒号缺失 / 落在首末位),
-- 那些行在 T01 被**故意**留成 NULL, 下面的 `SET NOT NULL` 会在此**炸掉部署** —— 这是设计意图:
-- 迁移期喊出来, 远好过运行期让一只锚静默落在所有市场页签之外。
--
-- ## CHECK 的职责边界
--
-- 值域是 `anchor-import.rules.ts` 的 `IMPORTABLE_MARKETS` 的**副本**, 改一处必改另一处 (schema.prisma
-- 该列注释亦记此)。它与两道写侧闸**不可互相替代**, 三者挡的是不同的东西:
--   · `ticker-search-picker.tsx` (UI)      —— 不受支持市场提交前即不可选 (SC-006)
--   · `create-anchor.usecase.ts` (应用层)  —— 全仓唯一 anchor INSERT 点, 拒非白名单 (FR-014)
--   · 本 CHECK (DB)                        —— 挡**所有**写入路径: migration 回填 / 测试直插 /
--     手工 SQL / 将来新增的任何 INSERT 点。应用层闸是代码, 代码有边界; CHECK 没有。
-- 它兑现的是 SC-003「两个页签所含锚的并集 = 全部锚, 交集为空」—— 让「不存在分不进任何页签的
-- 孤儿锚」成为结构性事实, 而不是「相信写侧代码没漏」。
--
-- 🚨 Prisma **不建模 CHECK 约束** ⇒ 后续任何 `migrate dev --create-only` 生成的 diff 都会把
--   `ck_anchor_market` 误报成待 `DROP CONSTRAINT` (同 pg_trgm GIN 索引 `ix_instrument_pinyin_abbr_trgm`
--   那类既有 committed 对象)。**生成后剔掉那一行**, 别让它进 migration。
--
-- migration_refs: specs/065-optionsdesk-radar-market-tabs (FR-013, FR-014, SC-003; plan §D0 步 2; T03)

-- AlterTable
ALTER TABLE "optionsdesk"."anchor" ALTER COLUMN "market" SET NOT NULL;

-- 值域闸 (IMPORTABLE_MARKETS 的 DB 侧副本)
ALTER TABLE "optionsdesk"."anchor"
  ADD CONSTRAINT "ck_anchor_market" CHECK ("market" IN ('us', 'hk'));
