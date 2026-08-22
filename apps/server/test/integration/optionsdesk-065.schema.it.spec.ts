import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setupEmptyDb } from '../_support/isolated-db';
import { runMigrateDeploy } from '../_support/run-migrate';
import { PrismaService } from '../../src/security/prisma.service';
import { parseAnchorTicker } from '../../src/optionsdesk/anchor.rules';

// 065 T01 schema IT: `optionsdesk.anchor` 加 `market` 列 —— **expand 步**（ADR-0035）。
// **必须真 PG**: 被测对象**就是 `migrate deploy` 的产物本身**（列在不在册 / 可空真不真 /
// 回填谓词与 `parseAnchorTicker` 是否真的逐行同解），这些在 schema.prisma 静态读取或任何
// mock 里都不存在 ⇒ 取 `setupEmptyDb()`（三入口中「自己跑 migrate deploy 并验证其产物」
// 那一个；换成 setupIsolatedDb 的模板克隆会把被测对象整个抽掉，**而且不会红、也不会变慢** ——
// 只是悄悄不再验证任何东西）。
//
// 🚨 **本文件只验 expand**。收紧成 NOT NULL + `ck_anchor_market` CHECK 的 **contract 步**
// 连同它的断言（NOT NULL / 直插 cn 撞 CHECK / CHECK 值域恰好 = `IMPORTABLE_MARKETS`）
// 走**另一个 PR、另一次部署** —— prod 回滚只换镜像 tag、不回退 schema，两步挤进同一次发布会让
// 那次发布**不可用 `rollback-prod.sh` 回滚**（ops/runbook「image-only 回滚的硬前提」）。
describe('065 anchor.market expand（Testcontainers PG migrate deploy）', () => {
  let prisma: PrismaService;
  let db: Awaited<ReturnType<typeof setupEmptyDb>>;

  const ANCHOR_MINIMAL = {
    v: '50',
    asof: new Date('2026-06-30T00:00:00Z'),
    method: 'dcf',
    confidence: '8',
    confidenceSource: 'manual',
    lLevelEffective: 'L2',
  };

  beforeAll(async () => {
    db = await setupEmptyDb();
    process.env.DATABASE_URL = db.databaseUrl;

    runMigrateDeploy();

    prisma = new PrismaService(db.databaseUrl);
    await prisma.$connect();
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  it('market 列在册、**可空**、无默认值、VarChar(4)', async () => {
    const cols = await prisma.$queryRawUnsafe<
      {
        column_name: string;
        is_nullable: string;
        column_default: string | null;
        character_maximum_length: number | null;
      }[]
    >(
      `SELECT column_name, is_nullable, column_default, character_maximum_length
         FROM information_schema.columns
        WHERE table_schema = 'optionsdesk' AND table_name = 'anchor' AND column_name = 'market'`,
    );
    expect(cols).toHaveLength(1);
    expect(cols[0]?.is_nullable).toBe('YES'); // expand 步：先可空
    // 🚨 无默认值是刻意的：给个 'us' 默认会让「忘了派生 market」的写路径静默落成美股锚
    // （FR-013 归属错得看不出来），而无默认时那种行会显式留 NULL、被 contract 步喊出来。
    expect(cols[0]?.column_default).toBeNull();
    expect(cols[0]?.character_maximum_length).toBe(4);
  });

  it('🚨 可空是**刻意的中间态**：不写 market 也 INSERT 得进去（image-only 回滚的前提）', async () => {
    // 这条钉的正是「本次发布向后兼容、可回滚」这个性质：回滚到不写该列的旧镜像时，建锚仍然
    // 能落库。contract 步一旦落地它就会红 —— 那时**应当**红，因为回滚窗口确实关闭了，
    // 届时本条随断言一起搬去 contract 的那个 PR 并反转成 NOT NULL。
    const row = await prisma.anchor.create({
      data: { ...ANCHOR_MINIMAL, ticker: 'us:LEGACY' },
    });
    expect(row.market).toBeNull();
    await prisma.anchor.delete({ where: { id: row.id } });
  });

  it('🚨 T01 回填谓词逐字镜像 parseAnchorTicker；畸形行**故意**留 NULL', async () => {
    // 取**真正落库的那段 SQL**，不是抄一份副本 —— 副本会与 migration 各自演化，而这条测试的
    // 全部价值就在于「回填与 TS 侧解析器同解」这个跨语言不变式。
    const addMarketSql = readFileSync(
      resolve(process.cwd(), 'prisma/migrations/20260821_1554_add_anchor_market/migration.sql'),
      'utf-8',
    );
    const backfillSql = addMarketSql.slice(addMarketSql.indexOf('UPDATE "optionsdesk"."anchor"'));
    expect(backfillSql).toContain('SET "market" =');

    // well-formed 三只（含非白名单的 jp —— 回填只管**解析**，值域是 contract 步 CHECK 的事，
    // 两者不同量纲）+ 畸形三只（无冒号 / 冒号在首位 / 冒号在末位）。
    const SAMPLES = ['us:AOS', 'hk:00700', 'jp:7203', 'us:BRK.B', 'PEP', ':AOS', 'us:'];
    for (const ticker of SAMPLES) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "optionsdesk"."anchor"
           (ticker, v, asof, method, confidence, confidence_source, l_level_effective)
         VALUES ($1, 50, DATE '2026-06-30', 'dcf', 8, 'manual', 'L2')`,
        ticker,
      );
    }

    await prisma.$executeRawUnsafe(backfillSql); // 幂等：谓词带 `market IS NULL`

    for (const ticker of SAMPLES) {
      const row = await prisma.$queryRawUnsafe<{ market: string | null }[]>(
        `SELECT market FROM "optionsdesk"."anchor" WHERE ticker = $1`,
        ticker,
      );
      // 逐行同解：SQL 侧的 left(...position...) 与 TS 侧的 parseAnchorTicker 对同一个 ticker
      // MUST 给出同一个归属，包括「都判它非法」的那三只。
      expect([ticker, row[0]?.market ?? null]).toEqual([
        ticker,
        parseAnchorTicker(ticker)?.market ?? null,
      ]);
    }

    // 畸形行留 NULL 是**故意**的：它们会在 contract 步的 `SET NOT NULL` 上炸掉部署，
    // 而那正是设计意图 —— 迁移期喊出来，远好过运行期让一只锚静默落在所有市场页签之外。
    const orphans = await prisma.anchor.count({ where: { market: null } });
    expect(orphans).toBe(3);
  });
});
