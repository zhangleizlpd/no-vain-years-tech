-- #255: 订正 2026-08-28 08:00 那批**按美股语义写进港股**的快照行。
-- **纯 UPDATE + DELETE, 无 DDL。**
--
-- ══ 这批行是怎么进来的 ═════════════════════════════════════════════════════════════════
-- `option-snapshot-coverage.check.ts` 的基线日 / 分母 / 分子三处查询没有市场谓词（那个「只有
-- 美股」的前提不是写成字面量，是写成**没有过滤条件**）⇒ 港股合约混进 `OptionSnapshotRemediation`
-- 的美股分母 ⇒ `hk:00700` 被判覆盖不足 ⇒ 08:00 那轮当日重试拿 `marketScope: ['us']` 把它整票
-- 重采了一遍，并按美股归属语义落库：
--   · `source = 'eod'`      —— 与当晚 00:36 夜链那批 `premarket_backfill` 行**并存**（唯一键
--     第三段是 source，两套语义的行互不冲突、无任何报错）
--   · `oi_as_of = 2026-08-26` —— 美股口径「T 日 OI 要 T+1 盘前才发布」。**对港股是错的**：
--     港股 OI 在 D 日收盘当晚 21:30 定稿（`MARKET_OI_SETTLE_LOCAL_MINUTE.hk`，066 T09 实测），
--     session `2026-08-27` 的 `oi_as_of` 就该是 `2026-08-27`。
-- 而 `leg-retrieval.adapter.ts` 的多来源去重取 `max(quote_as_of)` ⇒ 08:00 那批（08-28 00:00:05Z）
-- 恒定胜过夜链那批（08-27 16:36:46Z）⇒ **读侧读到的一直是错标的那份**。
--
-- 代码侧的根因已随同一 feature 修掉（四处查询按市场收窄 + `collect()` 加 fail-closed 不变式 +
-- 探针 SQL 同步收窄）。本条清理的是修法生效**之前**已经写进库的那批。
--
-- ══ 两步，各自的判据 ═══════════════════════════════════════════════════════════════════
-- ① UPDATE：按不变式 `hk ⇒ oi_as_of ≡ session_date` 修标签。判据与
--    `20260825_1910_relabel_hk_option_oi_as_of` **逐字同形**（那条修的是 066 T09 生效前的
--    523 行）—— 🚫 同样不按 `source = 'eod'` 写：hk 的两条路径都取 `session_date`，
--    不变式与 source 无关。
-- ② DELETE：删掉「同一 (合约, session) 上已有一条**更早**的 `premarket_backfill` 行」的那些
--    `eod` 行 —— 让「夜链写的那份是权威」重新成立。
--
--    🚨 判据为什么带 `quote_as_of` 比较，而不是只按 `source = 'eod'`：
--    「更晚采的那条」正是跨市场重采的签名。合法的 `eod` 行**恒早于**次日盘前的兜底行
--    （夜链 23:00 → 兜底次日 08:30），且 ② 级只重采覆盖率不达标的票 —— 一只票有了 eod 行就
--    不缺，② 级根本不会碰它。⇒ 本谓词命中不了任何一条合法行，将来也不会。
--
-- ══ 影响面与安全阀 ═════════════════════════════════════════════════════════════════════
-- 撰写时（2026-08-28）对 prod 实测：
--   · ① 命中 **1110 行**（`session_date = 2026-08-27`，`oi_as_of = 2026-08-26`，全部 hk:00700）
--   · ② 命中 **1106 行**；剩下 **4 行**是夜链被硬门 `ask_below_intrinsic` 拒掉、只有这一份来源
--     的合约（`HK.TCH260929P630000/640000/650000`、`HK.TCH261230P720000`，见 #261）
--     ⇒ **必须留着**：快照是时间序列，vendor 不提供历史，删了就是永久缺口。
--
-- 🚨 下面的 `DO` 块是安全阀：② 的命中数超过 5000 就 `RAISE EXCEPTION` 让本次迁移失败。
--    不对称性：误删的代价是**买不回来的数据**，而误留只是几行标签正确但冗余的历史行。
--    ⇒ 宁可让部署**响亮地失败**（可再发一条迁移修正），也不要静默多删。
--    5000 ≈ 实测值的 4.5 倍，留给「部署前又被多写几轮」的余量。
--
-- ⚠️ 幂等：① 重跑零行（`WHERE oi_as_of <> session_date`）；② 重跑零行（premarket 行还在、
--    但对应的 eod 行已删 ⇒ 谓词空集）。
-- ⚠️ 不可逆：② 删掉后无法从库里区分「本来就没有」与「被本条删掉」。判据可从本文件复原，
--    `_prisma_migrations` 留有执行记录；被删的行其值与夜链那份同源（同一场次的收盘态），
--    唯一丢失的是「08:00 那次采集发生过」这个事实本身。
--
-- migration_refs: #255（跨市场重采）/ #261（那 4 张被硬门拒掉的深实值腿）/
--                 20260825_1910_relabel_hk_option_oi_as_of（① 的判据先例）

DO $$
DECLARE
  -- 阀值只写这一处 —— 报错文案用 `%` 引它，别把数字抄进文案（抄了改阀值时文案就成了假话）。
  max_deletable constant bigint := 5000;
  deletable bigint;
BEGIN
  SELECT count(*) INTO deletable
  FROM "marketdata"."option_daily_snapshot" AS s
  JOIN "marketdata"."option_contract" AS c ON c."id" = s."contract_id"
  WHERE c."market" = 'hk'
    AND s."source" = 'eod'
    AND EXISTS (
      SELECT 1
      FROM "marketdata"."option_daily_snapshot" AS o
      WHERE o."contract_id" = s."contract_id"
        AND o."session_date" = s."session_date"
        AND o."source" = 'premarket_backfill'
        AND o."quote_as_of" < s."quote_as_of"
    );

  IF deletable > max_deletable THEN
    RAISE EXCEPTION
      '跨市场重采行命中 % 条, 超过安全阀 % —— 拒绝静默删除。先人工核对判据是否假阳性 (见本迁移文件头「影响面与安全阀」), 再决定放宽阀值还是收窄判据。',
      deletable, max_deletable;
  END IF;
END
$$;

-- ① 标签：hk 的不变式是 `oi_as_of ≡ session_date`，与 source 无关。
UPDATE "marketdata"."option_daily_snapshot" AS s
SET "oi_as_of" = s."session_date"
FROM "marketdata"."option_contract" AS c
WHERE c."id" = s."contract_id"
  AND c."market" = 'hk'
  AND s."oi_as_of" <> s."session_date";

-- ② 冗余行：夜链那份是权威，删掉后来居上的那条 eod 行（只有它比 premarket 行采得更晚）。
DELETE FROM "marketdata"."option_daily_snapshot" AS s
USING "marketdata"."option_contract" AS c
WHERE c."id" = s."contract_id"
  AND c."market" = 'hk'
  AND s."source" = 'eod'
  AND EXISTS (
    SELECT 1
    FROM "marketdata"."option_daily_snapshot" AS o
    WHERE o."contract_id" = s."contract_id"
      AND o."session_date" = s."session_date"
      AND o."source" = 'premarket_backfill'
      AND o."quote_as_of" < s."quote_as_of"
  );
