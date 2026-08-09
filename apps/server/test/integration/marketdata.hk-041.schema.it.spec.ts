import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';

const NEW_TABLES = ['allotment_event', 'buyback_event', 'equity_change', 'shareholder_change'];
const NEW_DIMS = ['allotment', 'buyback', 'equity_change', 'shareholder_change'];
// 期望 seed 画像 (T002 migration): market_scope={hk} + history_depth=3650 (4 维均可回填近 10 年) 全体;
// cron 分档 (FR-012): 回购/股本变动=日频 '0 0 22 * * *'、股东权益变动/配股=周频 Monday '0 0 22 * * 1';
// freshness=slow-drift (低频披露, 不做新鲜度门); priority 逐维度 (均 < p1 核心 6 维 5-10)。
const DAILY_CRON = '0 0 22 * * *';
const WEEKLY_CRON = '0 0 22 * * 1';
const EXPECTED_DIM = {
  buyback: { depth: 3650, priority: 4, freshness: 'slow-drift', cron: DAILY_CRON },
  equity_change: { depth: 3650, priority: 3, freshness: 'slow-drift', cron: DAILY_CRON },
  shareholder_change: { depth: 3650, priority: 2, freshness: 'slow-drift', cron: WEEKLY_CRON },
  allotment: { depth: 3650, priority: 1, freshness: 'slow-drift', cron: WEEKLY_CRON },
} as const;

// 041 T003 Phase 1 Independent Test: 港股事件流 4 张 market-agnostic 事实表 schema expand
// (expand-only, ADR-0035) — migrate deploy 后验 4 表 + 4 唯一约束 + instrument FK cascade +
// 4 sync_dimension seed 行 (marketScope={hk}/history_depth/cron 分档/freshness) + 4 universe→dim soft 边。
// 纯数据层 (不动 TS executor) ⇒ 立即编译绿。
// 覆盖 state_branch: `新表 market-agnostic` / `依赖 universe` (soft 边) / `4 维度 marketScope 纳入` (seed 层);
// 覆盖 FR-012 (cronExpr 分档: buyback·equity_change 日频、shareholder·allotment 周频)。
describe('041 hk corporate-event schema expand (Testcontainers PG migrate deploy)', () => {
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

  it('4 张新事实表落库 (marketdata schema, 无 hk_* 前缀 → market-agnostic)', async () => {
    const rows = await prisma.$queryRawUnsafe<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'marketdata' AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      NEW_TABLES,
    );
    expect(rows.map((r) => r.table_name)).toEqual(NEW_TABLES);
  });

  it('4 唯一约束索引存在 (uk_*, 自然键去重)', async () => {
    const expected = [
      'uk_allotment_event_instrument_date',
      'uk_buyback_event_instrument_date_vendor', // C1: 扩键含 vendor_event_id
      'uk_equity_change_instrument_date',
      'uk_shareholder_change_instrument_date_name_hash', // C1: 扩键含 content_hash
    ];
    const rows = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'marketdata' AND indexname = ANY($1::text[])
       ORDER BY indexname`,
      expected,
    );
    expect(rows.map((r) => r.indexname)).toEqual(expected);
  });

  it('instrument FK cascade: 删 instrument 连带删 4 张表子行 (含嵌套 L/S payload)', async () => {
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
    await prisma.buybackEvent.create({
      data: {
        instrumentId: inst.id,
        date: new Date('2026-01-02'),
        vendorEventId: '68f6e365d5961364e4428dcd',
        num: 100000n,
        highestPrice: '419.0040',
        lowestPrice: '410.0000',
        avgPrice: '415.5000',
        totalPaid: '574035480.00',
        totalSharesForCancellation: 100000n,
        ratioPurchasedSinceResolution: '0.024450',
        methodOfPurchase: 'On market',
        currency: 'HKD',
        boardType: 'Main Board',
      },
    });
    await prisma.equityChange.create({
      data: {
        instrumentId: inst.id,
        date: new Date('2026-01-03'),
        capitalization: '9600000000',
        capitalizationH: '9600000000',
        changeReason: 'Share option scheme',
        declarationDate: new Date('2026-01-01'),
      },
    });
    await prisma.shareholderChange.create({
      data: {
        instrumentId: inst.id,
        date: new Date('2026-01-04'),
        shareholderName: 'Naspers Limited',
        contentHash: 'sc-cascade-1',
        // vendor 原始行整存 payload (plan Decision 4)
        payload: {
          numOfSharesInterestedList: [
            { value: '2500000000', sharesType: 'L' },
            { value: '0', sharesType: 'S' },
          ],
          percentageOfIssuedVotingShares: [{ value: '26.05', sharesType: 'L' }],
        },
      },
    });
    await prisma.allotmentEvent.create({
      data: {
        instrumentId: inst.id,
        date: new Date('2026-01-05'),
        payload: { ratio: '1:5', price: '10.50', currency: 'HKD' },
      },
    });

    await prisma.instrument.delete({ where: { id: inst.id } });

    expect(await prisma.buybackEvent.count({ where: { instrumentId: inst.id } })).toBe(0);
    expect(await prisma.equityChange.count({ where: { instrumentId: inst.id } })).toBe(0);
    expect(await prisma.shareholderChange.count({ where: { instrumentId: inst.id } })).toBe(0);
    expect(await prisma.allotmentEvent.count({ where: { instrumentId: inst.id } })).toBe(0);
  });

  it('唯一约束: 重复自然键 insert 拒 (buyback 3列 (instrumentId,date,vendorEventId) / equity/allotment (instrumentId,date) / shareholder 4列)', async () => {
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
    // buyback: C1 扩键 (instrumentId,date,vendorEventId) — 同三列 → 拒; 同 (date) 不同 vendorEventId → 允许 (同日两笔)。
    await prisma.buybackEvent.create({
      data: { instrumentId: inst.id, date: new Date('2026-02-02'), vendorEventId: 'A', num: 1n },
    });
    // 同 (date) 不同 vendorEventId → 允许 (同日多笔真行, 照汇丰同日两市场回购)。
    await prisma.buybackEvent.create({
      data: { instrumentId: inst.id, date: new Date('2026-02-02'), vendorEventId: 'B', num: 2n },
    });
    // 同三列自然键 → 拒。
    await expect(
      prisma.buybackEvent.create({
        data: { instrumentId: inst.id, date: new Date('2026-02-02'), vendorEventId: 'A', num: 3n },
      }),
    ).rejects.toThrow();
    expect(
      await prisma.buybackEvent.count({
        where: { instrumentId: inst.id, date: new Date('2026-02-02') },
      }),
    ).toBe(2); // 同日两笔 (vendorEventId A/B) 都落

    // equity_change: 同 (instrumentId,date) → 拒 (NK 不动, 探针证 1/日安全)。
    await prisma.equityChange.create({
      data: { instrumentId: inst.id, date: new Date('2026-02-03'), capitalization: '1' },
    });
    await expect(
      prisma.equityChange.create({
        data: { instrumentId: inst.id, date: new Date('2026-02-03'), capitalization: '2' },
      }),
    ).rejects.toThrow();

    // allotment: 同 (instrumentId,date) → 拒 (NK 不动, 零样本)。
    await prisma.allotmentEvent.create({
      data: { instrumentId: inst.id, date: new Date('2026-02-04'), payload: { a: 1 } },
    });
    await expect(
      prisma.allotmentEvent.create({
        data: { instrumentId: inst.id, date: new Date('2026-02-04'), payload: { a: 2 } },
      }),
    ).rejects.toThrow();

    // shareholder: C1 扩键 (instrumentId,date,shareholderName,contentHash)。
    // 同 (date) 不同 shareholderName → 允许 (同日多股东)。
    await prisma.shareholderChange.create({
      data: {
        instrumentId: inst.id,
        date: new Date('2026-02-05'),
        shareholderName: 'BlackRock',
        contentHash: 'h1',
        payload: {},
      },
    });
    await prisma.shareholderChange.create({
      data: {
        instrumentId: inst.id,
        date: new Date('2026-02-05'),
        shareholderName: 'Vanguard',
        contentHash: 'h1',
        payload: {},
      },
    });
    // 同 (date, shareholderName) 不同 contentHash → 允许 (同名同日多笔申报, C1)。
    await prisma.shareholderChange.create({
      data: {
        instrumentId: inst.id,
        date: new Date('2026-02-05'),
        shareholderName: 'BlackRock',
        contentHash: 'h2',
        payload: { x: 1 },
      },
    });
    // 同四列自然键 → 拒。
    await expect(
      prisma.shareholderChange.create({
        data: {
          instrumentId: inst.id,
          date: new Date('2026-02-05'),
          shareholderName: 'BlackRock',
          contentHash: 'h1',
          payload: { y: 2 },
        },
      }),
    ).rejects.toThrow();
    expect(
      await prisma.shareholderChange.count({
        where: { instrumentId: inst.id, date: new Date('2026-02-05') },
      }),
    ).toBe(3); // BlackRock(h1) + Vanguard(h1) + BlackRock(h2)
  });

  it('seed 4 维度行: marketScope=[hk] + history_depth=3650 + freshness=slow-drift + priority<核心', async () => {
    const dims = await prisma.syncDimension.findMany({
      where: { dimensionKey: { in: [...NEW_DIMS] } },
    });
    expect(dims).toHaveLength(4);
    for (const dim of dims) {
      const expected = EXPECTED_DIM[dim.dimensionKey as keyof typeof EXPECTED_DIM];
      expect(dim.marketScope).toEqual(['hk']); // 覆盖 state_branch `4 维度 marketScope 纳入`
      expect(dim.enabled).toBe(true);
      expect(dim.vendor).toBe('lixinger');
      expect(dim.batchSize).toBe(1);
      expect(dim.historyDepth).toBe(expected.depth); // 4 维均可回填近 10 年事件历史
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

  it('seed cron 分档 (FR-012): 回购/股本变动=日频、股东权益变动/配股=周频', async () => {
    const dims = await prisma.syncDimension.findMany({
      where: { dimensionKey: { in: [...NEW_DIMS] } },
    });
    const byKey = new Map(dims.map((d) => [d.dimensionKey, d.cronExpr]));
    // 高频事件及时入库 → 日频。
    expect(byKey.get('buyback')).toBe(DAILY_CRON);
    expect(byKey.get('equity_change')).toBe(DAILY_CRON);
    // 低频披露省调用 → 周频 (Monday)。
    expect(byKey.get('shareholder_change')).toBe(WEEKLY_CRON);
    expect(byKey.get('allotment')).toBe(WEEKLY_CRON);
    // 分档正交: 2 日频 + 2 周频。
    const cadence = dims.map((d) => d.cronExpr);
    expect(cadence.filter((c) => c === DAILY_CRON)).toHaveLength(2);
    expect(cadence.filter((c) => c === WEEKLY_CRON)).toHaveLength(2);
  });

  it('seed 4 universe→dim soft 边 (依赖 universe, 全 soft)', async () => {
    const edges = await prisma.syncDependency.findMany({
      where: { upstream: 'universe', downstream: { in: [...NEW_DIMS] } },
      orderBy: { downstream: 'asc' },
    });
    expect(edges).toHaveLength(4);
    expect(edges.every((e) => e.mode === 'soft')).toBe(true);
    expect(edges.map((e) => e.downstream)).toEqual([...NEW_DIMS].sort());
  });
});
