-- 065 雷达按市场分页签 · **expand 步** (T01): `optionsdesk.anchor` 加市场归属一列 + 一次性回填。
-- 列 nullable、无默认值、无约束变更 ⇒ expand-only, 零破坏性变更。
--
-- ## 为什么够格当列
--
-- 判据是 `schema.prisma` 该 model 头注释的 FR-003a ③「参与 SQL 筛选/排序的生效值 → 落**普通列**、
-- 应用层写入时求值」, 与 `l_level_effective` 同体例。market 自本片起要进雷达的 `WHERE` 与
-- `GROUP BY`; 在 SQL 里现解析 ticker 前缀会与 `parseAnchorTicker` 对同一行给出**不一致的归属**
-- (`us:` 这种空 code 串: SQL 前缀切分给 `us`, 而 TS 判它非法), 落列把这一整类问题消掉。
--
-- 🚨 **MUST NOT 改成 DB 生成列** —— 同 `l_level_effective` 的理由: 生成列会把解析表达式塞回 SQL,
--   正是本列要消灭的东西, 且改解析口径就得走 DDL 变更。
--
-- ## 为什么这次不是「双写必 drift」
--
-- `option_contract` 曾以「`expiry_date` 本身就是权威判据, 再存一份即双写必 drift」拒过加派生列。
-- 本列不同处有三, 缺一不可: ① `ticker` 建后不可变 (`UpdateAnchorRequest` 无该字段, 全仓无第二处
-- 写 `ticker`) ⇒ 这一对值写一次、此后永不各自演化, drift 没有发生的时间窗; ② 写入侧由
-- `parseAnchorTicker` **单点**派生 (T02); ③ 值域由 T03 的 CHECK 在 DB 层兜底, 与
-- `anchor-import.rules.ts` 的 `IMPORTABLE_MARKETS` 成对。
--
-- ## 回填
--
-- 下面的 UPDATE 是**一次性**的, 与「运行时不做字符串解析」不矛盾 —— 那条规矩从 T04 读路径切到本列
-- 之后才开始约束。谓词**逐字镜像** `anchor.rules.ts` 的 `parseAnchorTicker`: 按**首个**冒号切,
-- 冒号落在首位或末位一律判非法 ⇒ 那些行**故意**留 NULL, 交给 T03 的 `SET NOT NULL` 在迁移期喊出
-- 来, 而不是在运行期静默算错。
--
-- 取证 (2026-08-21; 判据 = `parseAnchorTicker` + `IMPORTABLE_CODE_PATTERN` + 32 字符上限三样合起来):
--   prod 16 行全部 well-formed `us:*`、0 畸形; dev 12 行同形 ⇒ 本次回填 100% 覆盖, 无残留 NULL。
--
-- ⚠️ 市场段超过 4 字符的行会在此 UPDATE 上因 VARCHAR(4) 溢出而**失败**。这是刻意的: 迁移期炸远好
--   过运行期静默截断。当前两库均无此类行。
--
-- 🚨 **本步与 T03 (`SET NOT NULL` + CHECK) MUST NOT 合并成一个 migration**: prod 回滚只换镜像 tag、
--   不回退 DB schema; 合并后回滚到旧镜像会因旧代码不写该列而 INSERT 失败 (脏回滚)。
--
-- DDL 段由 `prisma migrate dev --create-only` 从 schema.prisma 生成 (零 drift), 剔除 diff 误报的
-- `DROP INDEX ix_instrument_pinyin_abbr_trgm` (pg_trgm GIN 索引 schema.prisma 无法建模, 属既有
-- committed 索引 20260602_1430, 本 migration 不触)。
--
-- migration_refs: specs/065-optionsdesk-radar-market-tabs (FR-013; plan §D0 步 1; T01)

-- AlterTable
ALTER TABLE "optionsdesk"."anchor" ADD COLUMN     "market" VARCHAR(4);

-- Backfill (一次性; 谓词逐字镜像 anchor.rules.ts 的 parseAnchorTicker)
UPDATE "optionsdesk"."anchor"
   SET "market" = left("ticker", position(':' in "ticker") - 1)
 WHERE "market" IS NULL
   AND position(':' in "ticker") > 1
   AND position(':' in "ticker") < length("ticker");
