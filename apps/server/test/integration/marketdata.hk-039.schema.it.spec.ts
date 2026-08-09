import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';

const NEW_TABLES = [
  'connect_holding_daily',
  'fund_company_holding',
  'fund_holding',
  'index_membership',
  'short_selling_daily',
];
const NEW_DIMS = [
  'connect_holding',
  'fund_company_holding',
  'fund_holding',
  'index_membership',
  'short_selling',
];
// 期望 seed 画像 (T002 migration): market_scope={hk} 全体; depth/priority/freshness 逐维度。
const EXPECTED_DIM = {
  short_selling: { depth: 3650, priority: 4, freshness: 'continuous-daily' },
  connect_holding: { depth: 3650, priority: 3, freshness: 'continuous-daily' },
  fund_holding: { depth: 1825, priority: 2, freshness: 'slow-drift' },
  fund_company_holding: { depth: 1825, priority: 1, freshness: 'slow-drift' },
  index_membership: { depth: null as number | null, priority: 0, freshness: 'slow-drift' },
} as const;

// 039 T003 Phase 1 Independent Test: 港股量化高信号 5 张 market-agnostic 事实表 schema expand
// (expand-only, ADR-0035) — migrate deploy 后验 5 表 + 唯一约束 + instrument FK cascade +
// 5 sync_dimension seed 行 (marketScope={hk}/history_depth/priority) + 5 universe→dim soft 边。
// 纯数据层 (不动 TS executor) ⇒ 立即编译绿。
// 覆盖 state_branch: `5 张新表 market-agnostic` / `依赖 universe` (soft 边) / `5 维度 marketScope 纳入` (seed 层)。
describe('039 hk quant-signal schema expand (Testcontainers PG migrate deploy)', () => {
  let prisma: PrismaService;

  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;

    prisma = new PrismaService(db.databaseUrl);
    await prisma.$connect();
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  it('5 张新事实表落库 (marketdata schema, 无 hk_* 前缀 → market-agnostic)', async () => {
    const rows = await prisma.$queryRawUnsafe<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'marketdata' AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      NEW_TABLES,
    );
    expect(rows.map((r) => r.table_name)).toEqual(NEW_TABLES);
  });

  it('5 唯一约束索引存在 (uk_*, 自然键去重)', async () => {
    const expected = [
      'uk_connect_holding_daily_instrument_date',
      'uk_fund_company_holding_instrument_report_collection',
      'uk_fund_holding_instrument_report_fund',
      'uk_index_membership_instrument_index',
      'uk_short_selling_daily_instrument_date',
    ];
    const rows = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'marketdata' AND indexname = ANY($1::text[])
       ORDER BY indexname`,
      expected,
    );
    expect(rows.map((r) => r.indexname)).toEqual(expected);
  });

  it('instrument FK cascade: 删 instrument 连带删 5 张表子行', async () => {
    const inst = await prisma.instrument.create({
      data: {
        market: 'hk',
        code: '00700',
        name: '腾讯控股',
        type: 'stock',
        currency: 'HKD',
        status: 'active',
      },
    });
    await prisma.shortSellingDaily.create({
      data: {
        instrumentId: inst.id,
        date: new Date('2026-01-02'),
        shares: '1000',
        amount: '50000.00',
      },
    });
    await prisma.connectHoldingDaily.create({
      data: { instrumentId: inst.id, date: new Date('2026-01-02'), shareholdings: '2000' },
    });
    await prisma.indexMembership.create({
      data: { instrumentId: inst.id, indexCode: 'HSI', name: '恒生指数', source: 'lixinger' },
    });
    await prisma.fundHolding.create({
      data: {
        instrumentId: inst.id,
        reportDate: new Date('2025-12-31'),
        fundCode: 'F001',
        holdings: '500',
      },
    });
    await prisma.fundCompanyHolding.create({
      data: {
        instrumentId: inst.id,
        reportDate: new Date('2025-12-31'),
        fundCollectionCode: 'C001',
        holdings: '600',
      },
    });

    await prisma.instrument.delete({ where: { id: inst.id } });

    expect(await prisma.shortSellingDaily.count({ where: { instrumentId: inst.id } })).toBe(0);
    expect(await prisma.connectHoldingDaily.count({ where: { instrumentId: inst.id } })).toBe(0);
    expect(await prisma.indexMembership.count({ where: { instrumentId: inst.id } })).toBe(0);
    expect(await prisma.fundHolding.count({ where: { instrumentId: inst.id } })).toBe(0);
    expect(await prisma.fundCompanyHolding.count({ where: { instrumentId: inst.id } })).toBe(0);
  });

  it('唯一约束: 重复自然键 insert 拒 (short_selling (instrumentId,date) / fund_holding 三列)', async () => {
    const inst = await prisma.instrument.create({
      data: {
        market: 'hk',
        code: '00001',
        name: '长和',
        type: 'stock',
        currency: 'HKD',
        status: 'active',
      },
    });
    await prisma.shortSellingDaily.create({
      data: { instrumentId: inst.id, date: new Date('2026-02-02'), shares: '1' },
    });
    await expect(
      prisma.shortSellingDaily.create({
        data: { instrumentId: inst.id, date: new Date('2026-02-02'), shares: '2' },
      }),
    ).rejects.toThrow();

    await prisma.fundHolding.create({
      data: {
        instrumentId: inst.id,
        reportDate: new Date('2025-09-30'),
        fundCode: 'F009',
        holdings: '10',
      },
    });
    // 同 (instrumentId,reportDate) 不同 fundCode → 允许多行 (报告期×基金)。
    await prisma.fundHolding.create({
      data: {
        instrumentId: inst.id,
        reportDate: new Date('2025-09-30'),
        fundCode: 'F010',
        holdings: '20',
      },
    });
    // 同三列自然键 → 拒。
    await expect(
      prisma.fundHolding.create({
        data: {
          instrumentId: inst.id,
          reportDate: new Date('2025-09-30'),
          fundCode: 'F009',
          holdings: '30',
        },
      }),
    ).rejects.toThrow();
    expect(
      await prisma.fundHolding.count({
        where: { instrumentId: inst.id, reportDate: new Date('2025-09-30') },
      }),
    ).toBe(2);
  });

  it('seed 5 维度行: marketScope=[hk] + history_depth + priority + freshness_profile', async () => {
    const dims = await prisma.syncDimension.findMany({
      where: { dimensionKey: { in: [...NEW_DIMS] } },
    });
    expect(dims).toHaveLength(5);
    for (const dim of dims) {
      const expected = EXPECTED_DIM[dim.dimensionKey as keyof typeof EXPECTED_DIM];
      expect(dim.marketScope).toEqual(['hk']); // 覆盖 state_branch `5 维度 marketScope 纳入`
      expect(dim.enabled).toBe(true);
      expect(dim.vendor).toBe('lixinger');
      expect(dim.batchSize).toBe(1);
      expect(dim.historyDepth).toBe(expected.depth);
      expect(dim.priority).toBe(expected.priority);
      expect(dim.freshnessProfile).toBe(expected.freshness);
      expect(dim.slaHours).toBeNull(); // cadence 待 ops 验后设, 先不做新鲜度 gating
    }
    // 优先级严格低于 p1 核心 6 维 (5-10) → 核心先吃共享令牌桶。
    const core = await prisma.syncDimension.findMany({
      where: {
        dimensionKey: {
          in: ['universe', 'profile', 'eod_bar', 'fundamental', 'financial', 'corporate_action'],
        },
      },
    });
    const maxNew = Math.max(...dims.map((d) => d.priority));
    const minCore = Math.min(...core.map((d) => d.priority));
    expect(maxNew).toBeLessThan(minCore);
  });

  it('seed 5 universe→dim soft 边 (依赖 universe, 全 soft)', async () => {
    const edges = await prisma.syncDependency.findMany({
      where: { upstream: 'universe', downstream: { in: [...NEW_DIMS] } },
      orderBy: { downstream: 'asc' },
    });
    expect(edges).toHaveLength(5);
    expect(edges.every((e) => e.mode === 'soft')).toBe(true);
    expect(edges.map((e) => e.downstream)).toEqual([...NEW_DIMS].sort());
  });
});
