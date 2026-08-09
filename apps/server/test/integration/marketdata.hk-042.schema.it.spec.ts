import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';

// 表名 (sorted) — dimension_key 与表名有别: employee 维度落 employee_snapshot 表。
const NEW_TABLES = ['employee_snapshot', 'revenue_segment', 'shareholder_snapshot'];
const NEW_DIMS = ['employee', 'revenue_segment', 'shareholder_snapshot'];
// 期望 seed 画像 (T002 migration): market_scope={hk} + history_depth=3650 (3 维均可回填近 10 年报告期);
// cron 统一季频 (FR-011) '0 0 22 1 */3 *'; freshness=slow-drift (低频报告期披露, 不做新鲜度门);
// priority 逐维度 (revenue>shareholder>employee = US1>US2>US3, 均 < p1 核心 6 维 5-10)。
const QUARTERLY_CRON = '0 0 22 1 */3 *';
const EXPECTED_DIM = {
  revenue_segment: { depth: 3650, priority: 4, freshness: 'slow-drift', cron: QUARTERLY_CRON },
  shareholder_snapshot: { depth: 3650, priority: 3, freshness: 'slow-drift', cron: QUARTERLY_CRON },
  employee: { depth: 3650, priority: 2, freshness: 'slow-drift', cron: QUARTERLY_CRON },
} as const;

// 042 T003 Phase 1 Independent Test: 港股报告期 3 张 market-agnostic 事实表 schema expand
// (expand-only, ADR-0035) — migrate deploy 后验 3 表 + 3 唯一约束 + instrument FK cascade +
// 3 sync_dimension seed 行 (marketScope={hk}/history_depth/cron 季频/freshness/slaHours=null) +
// 3 universe→dim soft 边。纯数据层 (不动 TS executor) ⇒ 立即编译绿。
// 覆盖 state_branch: `新表 market-agnostic` / `依赖 universe` (soft 边) / `3 维度 marketScope 纳入` (seed 层);
// 覆盖 FR-011 (cronExpr 统一季频)。
describe('042 hk reporting-period schema expand (Testcontainers PG migrate deploy)', () => {
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

  it('3 张新事实表落库 (marketdata schema, 无 hk_* 前缀 → market-agnostic)', async () => {
    const rows = await prisma.$queryRawUnsafe<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'marketdata' AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      NEW_TABLES,
    );
    expect(rows.map((r) => r.table_name)).toEqual(NEW_TABLES);
  });

  it('3 唯一约束索引存在 (uk_*, 自然键去重)', async () => {
    const expected = [
      'uk_employee_snapshot_instrument_date_parent_item_type', // 员工 5 列 NK, 含 display_type
      'uk_revenue_segment_instrument_date_parent_item', // 营收 4 列 NK
      'uk_shareholder_snapshot_instrument_date_name_hash', // 最新股东 4 列 NK, 含 content_hash
    ];
    const rows = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'marketdata' AND indexname = ANY($1::text[])
       ORDER BY indexname`,
      expected,
    );
    expect(rows.map((r) => r.indexname)).toEqual(expected);
  });

  it('instrument FK cascade: 删 instrument 连带删 3 张表子行 (含嵌套 L/S payload)', async () => {
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
    await prisma.revenueSegment.create({
      data: {
        instrumentId: inst.id,
        date: new Date('2025-12-31'),
        declarationDate: new Date('2026-03-20'),
        currency: 'CNY',
        parentItemName: '按服務類型分',
        itemName: '增值服務',
        revenue: '300000000000.00',
        costs: '120000000000.00',
        grossProfitMargin: '0.600000',
      },
    });
    await prisma.shareholderSnapshot.create({
      data: {
        instrumentId: inst.id,
        date: new Date('2025-12-31'),
        shareholderName: 'Naspers Limited',
        contentHash: 'ss-cascade-1',
        // vendor 原始行整存 payload (plan Decision 4, 复用 041 范式)
        payload: {
          numOfSharesInterestedList: [
            { value: '2500000000', sharesType: 'L' },
            { value: '0', sharesType: 'S' },
          ],
          percentageOfIssuedVotingShares: [{ value: '26.05', sharesType: 'L' }],
        },
      },
    });
    await prisma.employeeSnapshot.create({
      data: {
        instrumentId: inst.id,
        date: new Date('2025-12-31'),
        declarationDate: new Date('2026-03-20'),
        parentItemName: '',
        itemName: '员工总数',
        displayType: 'number',
        value: '112771.0000',
      },
    });

    await prisma.instrument.delete({ where: { id: inst.id } });

    expect(await prisma.revenueSegment.count({ where: { instrumentId: inst.id } })).toBe(0);
    expect(await prisma.shareholderSnapshot.count({ where: { instrumentId: inst.id } })).toBe(0);
    expect(await prisma.employeeSnapshot.count({ where: { instrumentId: inst.id } })).toBe(0);
  });

  it('唯一约束: 重复自然键 insert 拒 (营收 4 列 / 最新股东 4 列含 contentHash / 员工 5 列含 displayType)', async () => {
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

    // revenue_segment: NK (instrumentId,date,parentItemName,itemName)。
    await prisma.revenueSegment.create({
      data: {
        instrumentId: inst.id,
        date: new Date('2025-06-30'),
        parentItemName: '按地區分',
        itemName: '香港',
        revenue: '1',
      },
    });
    // 同 (date,parent) 不同 itemName → 允许。
    await prisma.revenueSegment.create({
      data: {
        instrumentId: inst.id,
        date: new Date('2025-06-30'),
        parentItemName: '按地區分',
        itemName: '中國內地',
        revenue: '2',
      },
    });
    // 顶层行 parent 落 sentinel '' → 与分组行不撞。
    await prisma.revenueSegment.create({
      data: {
        instrumentId: inst.id,
        date: new Date('2025-06-30'),
        parentItemName: '',
        itemName: '合計',
        revenue: '3',
      },
    });
    // 同四列自然键 → 拒。
    await expect(
      prisma.revenueSegment.create({
        data: {
          instrumentId: inst.id,
          date: new Date('2025-06-30'),
          parentItemName: '按地區分',
          itemName: '香港',
          revenue: '9',
        },
      }),
    ).rejects.toThrow();
    expect(
      await prisma.revenueSegment.count({
        where: { instrumentId: inst.id, date: new Date('2025-06-30') },
      }),
    ).toBe(3);

    // employee_snapshot: NK 含 display_type — 同 (parent,item) 不同 displayType (number/percentage) → 都落。
    // probe 实证「流失率按性别分‖男性」= {58812 number, 15.2 percentage} (加 display_type 全期 0 碰撞)。
    await prisma.employeeSnapshot.create({
      data: {
        instrumentId: inst.id,
        date: new Date('2025-06-30'),
        parentItemName: '流失率按性别分',
        itemName: '男性',
        displayType: 'number',
        value: '58812.0000',
      },
    });
    await prisma.employeeSnapshot.create({
      data: {
        instrumentId: inst.id,
        date: new Date('2025-06-30'),
        parentItemName: '流失率按性别分',
        itemName: '男性',
        displayType: 'percentage',
        value: '15.2000',
      },
    });
    // 同五列自然键 → 拒。
    await expect(
      prisma.employeeSnapshot.create({
        data: {
          instrumentId: inst.id,
          date: new Date('2025-06-30'),
          parentItemName: '流失率按性别分',
          itemName: '男性',
          displayType: 'number',
          value: '99999.0000',
        },
      }),
    ).rejects.toThrow();
    expect(
      await prisma.employeeSnapshot.count({
        where: { instrumentId: inst.id, date: new Date('2025-06-30') },
      }),
    ).toBe(2); // number + percentage 两行都落 (displayType 进 NK 不 skipDuplicates)

    // shareholder_snapshot: NK (instrumentId,date,shareholderName,contentHash)。
    // 同 (date) 不同 shareholderName → 允许。
    await prisma.shareholderSnapshot.create({
      data: {
        instrumentId: inst.id,
        date: new Date('2025-06-30'),
        shareholderName: 'BlackRock',
        contentHash: 'h1',
        payload: {},
      },
    });
    await prisma.shareholderSnapshot.create({
      data: {
        instrumentId: inst.id,
        date: new Date('2025-06-30'),
        shareholderName: 'Vanguard',
        contentHash: 'h1',
        payload: {},
      },
    });
    // 同 (date,shareholderName) 不同 contentHash → 允许 (同名同日多笔, 复用 041 hashdiff 范式)。
    await prisma.shareholderSnapshot.create({
      data: {
        instrumentId: inst.id,
        date: new Date('2025-06-30'),
        shareholderName: 'BlackRock',
        contentHash: 'h2',
        payload: { x: 1 },
      },
    });
    // 同四列自然键 → 拒。
    await expect(
      prisma.shareholderSnapshot.create({
        data: {
          instrumentId: inst.id,
          date: new Date('2025-06-30'),
          shareholderName: 'BlackRock',
          contentHash: 'h1',
          payload: { y: 2 },
        },
      }),
    ).rejects.toThrow();
    expect(
      await prisma.shareholderSnapshot.count({
        where: { instrumentId: inst.id, date: new Date('2025-06-30') },
      }),
    ).toBe(3); // BlackRock(h1) + Vanguard(h1) + BlackRock(h2)
  });

  it('seed 3 维度行: marketScope=[hk] + history_depth=3650 + cron 季频 + freshness=slow-drift + slaHours=null + priority<核心', async () => {
    const dims = await prisma.syncDimension.findMany({
      where: { dimensionKey: { in: [...NEW_DIMS] } },
    });
    expect(dims).toHaveLength(3);
    for (const dim of dims) {
      const expected = EXPECTED_DIM[dim.dimensionKey as keyof typeof EXPECTED_DIM];
      expect(dim.marketScope).toEqual(['hk']); // 覆盖 state_branch `3 维度 marketScope 纳入`
      expect(dim.enabled).toBe(true);
      expect(dim.vendor).toBe('lixinger');
      expect(dim.batchSize).toBe(1);
      expect(dim.historyDepth).toBe(expected.depth); // 3 维均可回填近 10 年报告期历史
      expect(dim.priority).toBe(expected.priority);
      expect(dim.cronExpr).toBe(expected.cron); // FR-011 统一季频
      expect(dim.freshnessProfile).toBe(expected.freshness);
      expect(dim.slaHours).toBeNull(); // 报告期低频, 不做新鲜度 gating
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

  it('seed cron 统一季频 (FR-011): 3 维均 quarterly', async () => {
    const dims = await prisma.syncDimension.findMany({
      where: { dimensionKey: { in: [...NEW_DIMS] } },
    });
    const cadence = dims.map((d) => d.cronExpr);
    expect(cadence.filter((c) => c === QUARTERLY_CRON)).toHaveLength(3); // 全季频, 无日/周频
  });

  it('seed 3 universe→dim soft 边 (依赖 universe, 全 soft)', async () => {
    const edges = await prisma.syncDependency.findMany({
      where: { upstream: 'universe', downstream: { in: [...NEW_DIMS] } },
      orderBy: { downstream: 'asc' },
    });
    expect(edges).toHaveLength(3);
    expect(edges.every((e) => e.mode === 'soft')).toBe(true);
    expect(edges.map((e) => e.downstream)).toEqual([...NEW_DIMS].sort());
  });
});
