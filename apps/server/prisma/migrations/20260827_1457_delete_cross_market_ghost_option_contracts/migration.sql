-- #199: 删掉**跨市场幽灵合约** —— 挂在 us 标的名下、vendor 侧根本不存在的那些合约行。
-- **纯 DELETE, 无 DDL。** 级联（`option_daily_snapshot.contract_id` 上的 `ON DELETE CASCADE`）
-- 会一并带走它们的快照行。
--
-- ══ 它们是怎么进来的 ═══════════════════════════════════════════════════════════════════
-- 富途在美股方向按**词根**解析标的、忽略市场前缀（#179）。那个怪癖有**两种形态**：
--   · 形态 A（08-25 实测，#179 已修）：掺回的行带 `code=HK.ALB…` + `stock_owner=HK.09988`
--     ⇒ 链 adapter 按 owner 市场丢弃，入口已堵死。
--   · 形态 B（**08-22 实际发生**）：同一批合约被**整体重贴成** `code=US.ALB…` +
--     `stock_owner=US.ALB`。它**自洽** —— `dropForeignMarketRows` 的市场判据与
--     `sync-option-contract` 的护城河（owner ≠ 请求标的则 throw）**两道都看不见它**。
-- ⇒ 2026-08-22 13:41 us:ALB 建锚冷启动那一发，把阿里巴巴港股（hk:09988）的整条期权阶梯
--    （行权价 75–195，5 元档；真 US.ALB 那期是 101–149，1 元档）写进了 us:ALB 名下。
--
-- ══ 为什么必须删，而不是「等它自己好」═══════════════════════════════════════════════════
-- 合约表是 `createMany({ skipDuplicates: true })` 幂等落行、**只增不删** ⇒ 脏行不会自愈。
-- 而快照工作集取的就是这张表 ⇒ 幽灵 code 每晚随第一批发给 vendor，vendor 答
-- `未知股票 ALB260828C100000`，shim 映射 502、server 记 `TransientVendorError`
-- ⇒ **us:ALB 每晚整票零采**（2026-08-25 / 26 / 27 连续三轮 `partial`，`failed=1`）。
-- 快照是时间序列且供应方不提供历史 ⇒ **每多挂一晚就是一天永久缺口**。
--
-- 2026-08-27 实测（经受限通道直打上游，正反控制齐备）：
--   · `codes=US.ALB,US.ALB260828C100000` → 502 `未知股票 ALB260828C100000`
--   · `codes=US.ALB,US.ALB260828C101000`（vendor 链里真有的） → 200
--   · 第 1 批 399 个 code 剔掉幽灵后剩 253 个 → 200，count=254
-- ⇒ 批量大小 / 限频 / 网关全部无罪；就是这批 code 本身 vendor 不认。
--
-- ══ 判据为什么这么写 ═══════════════════════════════════════════════════════════════════
-- 判据 = 「同一个**合约标识**（code 去掉市场前缀那一段 = `root+到期+方向+行权价`）同时挂在一个
-- us 标的和一个 hk 标的名下」。vendor 侧一个合约标识只属于一个市场，所以两边同时有行 ⇒ 其中
-- 一边是脏行；而 `US.` 那边已被实证为 vendor 不认的那一边。
--
-- 🚫 **不按字面量 `code = 'ALB'` 写**（同 `20260825_1910_relabel_hk_option_oi_as_of` 的先例）：
--    按不变式写，将来别的词根撞名长出同样的脏行时这条清理仍然成立。
-- 🚨 判据与探针 `ops/jobs/marketdata-table-health.sql` 的 `ghost_contract` **同口径**（那条数的
--    正是本条删的行）。改一处必须改另一处，否则表现是「清理跑完探针还红」或「探针绿而库里仍脏」。
--
-- ══ 影响面与安全阀 ═════════════════════════════════════════════════════════════════════
-- 撰写时（2026-08-27 14:57）对 prod 全量副本实测：**146 行合约 + 级联 144 行快照，仅 us:ALB**。
-- 全库扫描确认没有第二只票命中。
--
-- 🚨 下面的 `DO` 块是**安全阀**：命中数超过 500 就 `RAISE EXCEPTION` 让本次迁移失败。理由是
--    不对称性 —— 判据理论上可能假阳性（真出现「同 root + 同到期 + 同方向 + 同行权价」的合法
--    重合），而误删的代价里有**买不回来的东西**（合约本身下轮链发现会补回，但级联带走的快照
--    是永久缺口）。⇒ 宁可让部署**响亮地失败**（可再发一条迁移修正），也不要静默多删。
--    500 ≈ 实测值的 3.4 倍，留给「部署前又被投毒一轮」的余量；再多就不是本条要修的那件事了。
--
-- ⚠️ 幂等：重跑为零行删除（脏行已不在，谓词自然空集）。
-- ⚠️ 不可逆：删掉后无法从库里区分「本来就没有」与「被本条删掉」。但判据可从本文件复原，
--    `_prisma_migrations` 留有执行记录，且被删的合约若哪天真是合法的，链发现下一轮会重新落行。
--
-- migration_refs: #199（us:ALB 连续三轮 502）/ #179（vendor 按词根串市场，形态 A 已修）

DO $$
DECLARE
  -- 阀值只写这一处 —— 下面的报错文案用 `%` 引它，别把数字抄进文案（抄了改阀值时文案就成了假话）。
  max_ghost constant bigint := 500;
  ghost_count bigint;
BEGIN
  SELECT count(*) INTO ghost_count
  FROM "marketdata"."option_contract" AS c
  JOIN "marketdata"."instrument" AS i ON i."id" = c."underlying_instrument_id"
  WHERE c."market" = 'us'
    AND i."market" = 'us'
    AND EXISTS (
      SELECT 1
      FROM "marketdata"."option_contract" AS h
      JOIN "marketdata"."instrument" AS hi ON hi."id" = h."underlying_instrument_id"
      WHERE h."market" = 'hk'
        AND hi."market" = 'hk'
        AND substring(h."code" FROM 4) = substring(c."code" FROM 4)
    );

  IF ghost_count > max_ghost THEN
    RAISE EXCEPTION
      '跨市场幽灵合约命中 % 行, 超过安全阀 % —— 拒绝静默删除。先人工核对判据是否假阳性 (见本迁移文件头「影响面与安全阀」), 再决定放宽阀值还是收窄判据。',
      ghost_count, max_ghost;
  END IF;
END
$$;

DELETE FROM "marketdata"."option_contract" AS c
USING "marketdata"."instrument" AS i
WHERE i."id" = c."underlying_instrument_id"
  AND c."market" = 'us'
  AND i."market" = 'us'
  AND EXISTS (
    SELECT 1
    FROM "marketdata"."option_contract" AS h
    JOIN "marketdata"."instrument" AS hi ON hi."id" = h."underlying_instrument_id"
    WHERE h."market" = 'hk'
      AND hi."market" = 'hk'
      AND substring(h."code" FROM 4) = substring(c."code" FROM 4)
  );
