import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setupEmptyDb } from '../_support/isolated-db';
import { runMigrateDeploy } from '../_support/run-migrate';
import { PrismaService } from '../../src/security/prisma.service';
import { parseAnchorTicker } from '../../src/optionsdesk/anchor.rules';
import { IMPORTABLE_MARKETS } from '../../src/optionsdesk/anchor-import.rules';

// 065 T03 schema IT: `optionsdesk.anchor.market` 从 expand 步的可空列收紧为 NOT NULL +
// `ck_anchor_market` 值域 CHECK (contract 步, ADR-0035) —— **必须真 PG**: 被测对象**就是
// `migrate deploy` 的产物本身** (NOT NULL 真不真 / CHECK 在不在册 / 它的值域到底是哪几个 /
// T01 的回填谓词与 `parseAnchorTicker` 是否真的逐行同解), 这四样在 schema.prisma 静态读取或
// 任何 mock 里都不存在 ⇒ 取 `setupEmptyDb()` (三入口中「自己跑 migrate deploy 并验证其产物」
// 那一个; 换成 setupIsolatedDb 的模板克隆会把被测对象整个抽掉, **而且不会红、也不会变慢** ——
// 只是悄悄不再验证任何东西)。
//
// 验 ① `market` NOT NULL 且无默认值 (回填已覆盖全部既有行的前提下才可能落地)
//    ② 直插 `cn` 撞 CHECK —— DB 层挡住写侧闸够不到的所有路径 (migration / 手工 SQL / 测试直插)
//    ③ 🚨 CHECK 的值域**恰好**等于 `IMPORTABLE_MARKETS` —— 把 schema.prisma 与 migration 里
//       「值域成对, 改一处必改另一处」那句注释变成机器强制。两边漂开的症状是**建锚 500 而非
//       400** (写侧放行、DB 拒), 且只在新增受支持市场那一天才炸, 没有别的东西会红。
//    ④ T01 回填谓词逐字镜像 `parseAnchorTicker`: well-formed 行归属一致、畸形行**故意**留 NULL
//       并由 `SET NOT NULL` 在迁移期炸出来 (而不是在运行期让一只锚静默落在所有页签之外)。
// 建锚侧的拒绝行为 (FR-014 / `INVALID_ANCHOR_MARKET`) 归 T02 的 use case spec, 不在本文件。
describe('065 anchor.market 收紧 NOT NULL + 值域 CHECK (Testcontainers PG migrate deploy)', () => {
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

  it('market 为 NOT NULL 且无默认值 (contract 步落地: 归属不再可缺席)', async () => {
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
    expect(cols[0]?.is_nullable).toBe('NO');
    // 🚨 无默认值是刻意的: 给个 'us' 默认会让「忘了派生 market」的写路径静默落成美股锚
    // (FR-013 归属错得看不出来), 而 NOT NULL 无默认时它当场 INSERT 失败。
    expect(cols[0]?.column_default).toBeNull();
    expect(cols[0]?.character_maximum_length).toBe(4);
  });

  it('🚨 直插 cn 撞 ck_anchor_market —— DB 挡的是写侧闸够不到的那些路径', async () => {
    // 写侧闸 (`create-anchor.usecase.ts`) 是代码, 只管它自己那一个入口; migration 回填 / 手工
    // SQL / 测试直插 / 将来任何新增的 INSERT 点都绕得过它。CHECK 绕不过 —— 它兑现的是 SC-003
    // 「两个页签所含锚的并集 = 全部锚」, 即「不存在分不进任何页签的孤儿锚」。
    await expect(
      prisma.anchor.create({ data: { ...ANCHOR_MINIMAL, ticker: 'cn:600519', market: 'cn' } }),
    ).rejects.toThrow();
    expect(await prisma.anchor.count({ where: { ticker: 'cn:600519' } })).toBe(0);
  });

  it('🚨 CHECK 的值域**恰好**是 IMPORTABLE_MARKETS (两边漂开 = 建锚 500 而非 400)', async () => {
    // 逐个试插比读 pg_constraint 的定义串更结实: 后者只能做文本比对, 改个空格或引号写法就假红,
    // 而「到底哪几个市场存得进去」才是这条约束的真实语义。
    const CANDIDATES = ['us', 'hk', 'cn', 'jp', 'uk', 'sg'] as const;
    const accepted: string[] = [];
    for (const market of CANDIDATES) {
      const ok = await prisma.anchor
        .create({ data: { ...ANCHOR_MINIMAL, ticker: `${market}:PROBE`, market } })
        .then(
          () => true,
          () => false,
        );
      if (ok) accepted.push(market);
    }
    expect(accepted).toEqual([...IMPORTABLE_MARKETS]);

    await prisma.anchor.deleteMany({ where: { ticker: { endsWith: ':PROBE' } } });
  });

  // ── ⚠️ 本条改 DDL (回到 T01 之后 / T03 之前的中间态), 故置于文件末尾 ──────────────
  it('🚨 T01 回填谓词逐字镜像 parseAnchorTicker; 畸形行留 NULL 并让 SET NOT NULL 炸在迁移期', async () => {
    // 取**真正落库的那段 SQL**, 不是抄一份副本 —— 副本会与 migration 各自演化, 而这条测试的
    // 全部价值就在于「回填与 TS 侧解析器同解」这个跨语言不变式。
    const addMarketSql = readFileSync(
      resolve(process.cwd(), 'prisma/migrations/20260821_1554_add_anchor_market/migration.sql'),
      'utf-8',
    );
    const backfillSql = addMarketSql.slice(addMarketSql.indexOf('UPDATE "optionsdesk"."anchor"'));
    expect(backfillSql).toContain('SET "market" =');

    await prisma.$executeRawUnsafe(
      `ALTER TABLE "optionsdesk"."anchor" DROP CONSTRAINT "ck_anchor_market"`,
    );
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "optionsdesk"."anchor" ALTER COLUMN "market" DROP NOT NULL`,
    );

    // well-formed 三只 (含非白名单的 jp —— 回填只管**解析**, 值域是 CHECK 的事, 两者不同量纲)
    // + 畸形三只 (无冒号 / 冒号在首位 / 冒号在末位)。
    const SAMPLES = ['us:AOS', 'hk:00700', 'jp:7203', 'us:BRK.B', 'PEP', ':AOS', 'us:'];
    for (const ticker of SAMPLES) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "optionsdesk"."anchor"
           (ticker, v, asof, method, confidence, confidence_source, l_level_effective)
         VALUES ($1, 50, DATE '2026-06-30', 'dcf', 8, 'manual', 'L2')`,
        ticker,
      );
    }

    await prisma.$executeRawUnsafe(backfillSql);

    for (const ticker of SAMPLES) {
      const row = await prisma.$queryRawUnsafe<{ market: string | null }[]>(
        `SELECT market FROM "optionsdesk"."anchor" WHERE ticker = $1`,
        ticker,
      );
      // 逐行同解: SQL 侧的 left(...position...) 与 TS 侧的 parseAnchorTicker 对同一个 ticker
      // MUST 给出同一个归属, 包括「都判它非法」的那三只。
      expect([ticker, row[0]?.market ?? null]).toEqual([
        ticker,
        parseAnchorTicker(ticker)?.market ?? null,
      ]);
    }

    // 畸形行还在 ⇒ T03 的 SET NOT NULL MUST 在此炸掉部署。这是设计意图: 迁移期喊出来, 远好过
    // 运行期让一只锚静默落在所有市场页签之外 (它在锚管理页仍完整列出, 只是雷达永远找不到它)。
    await expect(
      prisma.$executeRawUnsafe(
        `ALTER TABLE "optionsdesk"."anchor" ALTER COLUMN "market" SET NOT NULL`,
      ),
    ).rejects.toThrow();

    // 反向确认: 清掉畸形行后同一条 DDL 就能过 —— 证明刚才拦住它的是**残留 NULL**, 不是别的。
    await prisma.$executeRawUnsafe(`DELETE FROM "optionsdesk"."anchor" WHERE market IS NULL`);
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "optionsdesk"."anchor" ALTER COLUMN "market" SET NOT NULL`,
    );
  });
});
