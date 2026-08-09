import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';

const NEW_TABLES = ['hot_snapshot', 'volatility_daily'];
const NEW_DIMS = ['hot_snapshot', 'volatility'];
// 期望 seed 画像 (T002 migration): market_scope={hk} 全体; depth/priority/freshness 逐维度。
// volatility 日频历史近 10 年 (3650) continuous-daily; hot_snapshot 快照无历史 (NULL) slow-drift。
const EXPECTED_DIM = {
  volatility: { depth: 3650, priority: 4, freshness: 'continuous-daily' },
  hot_snapshot: { depth: null as number | null, priority: 3, freshness: 'slow-drift' },
} as const;

// 040 T003 Phase 1 Independent Test: 港股波动率 + 热度精选 2 张 market-agnostic 事实表 schema expand
// (expand-only, ADR-0035) — migrate deploy 后验 2 表 + 唯一约束 + instrument FK cascade +
// 2 sync_dimension seed 行 (marketScope={hk}/history_depth/priority/freshness) + 2 universe→dim soft 边。
// 纯数据层 (不动 TS executor) ⇒ 立即编译绿。
// 覆盖 state_branch: `2 张新表 market-agnostic` / `依赖 universe` (soft 边) / `2 维度 marketScope 纳入` (seed 层)。
describe('040 hk volatility+hot schema expand (Testcontainers PG migrate deploy)', () => {
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

  it('2 张新事实表落库 (marketdata schema, 无 hk_* 前缀 → market-agnostic)', async () => {
    const rows = await prisma.$queryRawUnsafe<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'marketdata' AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      NEW_TABLES,
    );
    expect(rows.map((r) => r.table_name)).toEqual(NEW_TABLES);
  });

  it('2 唯一约束索引存在 (uk_*, 自然键去重)', async () => {
    const expected = [
      'uk_hot_snapshot_instrument_type_date',
      'uk_volatility_daily_instrument_date_days',
    ];
    const rows = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'marketdata' AND indexname = ANY($1::text[])
       ORDER BY indexname`,
      expected,
    );
    expect(rows.map((r) => r.indexname)).toEqual(expected);
  });

  it('instrument FK cascade: 删 instrument 连带删 2 张表子行', async () => {
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
    await prisma.volatilityDaily.create({
      data: {
        instrumentId: inst.id,
        date: new Date('2026-01-02'),
        volatilityDays: 30,
        value: '0.33774930',
      },
    });
    await prisma.hotSnapshot.create({
      data: {
        instrumentId: inst.id,
        hotType: 'tr',
        dataDate: new Date('2026-01-02'),
        payload: { turnoverRate: 1.23, lastDataDate: '2026-01-02' },
      },
    });

    await prisma.instrument.delete({ where: { id: inst.id } });

    expect(await prisma.volatilityDaily.count({ where: { instrumentId: inst.id } })).toBe(0);
    expect(await prisma.hotSnapshot.count({ where: { instrumentId: inst.id } })).toBe(0);
  });

  it('唯一约束: 重复自然键 insert 拒 (volatility (instrumentId,date,volatilityDays) / hot (instrumentId,hotType,dataDate))', async () => {
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
    // 波动率: 同 (instrumentId,date) 不同窗口 → 允许多行 (每窗口一行, FR-002/FR-003)。
    await prisma.volatilityDaily.create({
      data: {
        instrumentId: inst.id,
        date: new Date('2026-02-02'),
        volatilityDays: 30,
        value: '0.1',
      },
    });
    await prisma.volatilityDaily.create({
      data: {
        instrumentId: inst.id,
        date: new Date('2026-02-02'),
        volatilityDays: 60,
        value: '0.2',
      },
    });
    // 同三列自然键 → 拒。
    await expect(
      prisma.volatilityDaily.create({
        data: {
          instrumentId: inst.id,
          date: new Date('2026-02-02'),
          volatilityDays: 30,
          value: '0.9',
        },
      }),
    ).rejects.toThrow();
    expect(
      await prisma.volatilityDaily.count({
        where: { instrumentId: inst.id, date: new Date('2026-02-02') },
      }),
    ).toBe(2);

    // 热度: 同 (instrumentId,hotType) 不同 dataDate → 允许多行 (前向累积序列, FR-004)。
    await prisma.hotSnapshot.create({
      data: {
        instrumentId: inst.id,
        hotType: 'capita',
        dataDate: new Date('2024-12-31'),
        payload: {},
      },
    });
    await prisma.hotSnapshot.create({
      data: {
        instrumentId: inst.id,
        hotType: 'capita',
        dataDate: new Date('2025-12-31'),
        payload: {},
      },
    });
    // 同三列自然键 → 拒。
    await expect(
      prisma.hotSnapshot.create({
        data: {
          instrumentId: inst.id,
          hotType: 'capita',
          dataDate: new Date('2024-12-31'),
          payload: { x: 1 },
        },
      }),
    ).rejects.toThrow();
    expect(
      await prisma.hotSnapshot.count({ where: { instrumentId: inst.id, hotType: 'capita' } }),
    ).toBe(2);
  });

  it('seed 2 维度行: marketScope=[hk] + history_depth + priority + freshness_profile', async () => {
    const dims = await prisma.syncDimension.findMany({
      where: { dimensionKey: { in: [...NEW_DIMS] } },
    });
    expect(dims).toHaveLength(2);
    for (const dim of dims) {
      const expected = EXPECTED_DIM[dim.dimensionKey as keyof typeof EXPECTED_DIM];
      expect(dim.marketScope).toEqual(['hk']); // 覆盖 state_branch `2 维度 marketScope 纳入`
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

  it('seed 2 universe→dim soft 边 (依赖 universe, 全 soft)', async () => {
    const edges = await prisma.syncDependency.findMany({
      where: { upstream: 'universe', downstream: { in: [...NEW_DIMS] } },
      orderBy: { downstream: 'asc' },
    });
    expect(edges).toHaveLength(2);
    expect(edges.every((e) => e.mode === 'soft')).toBe(true);
    expect(edges.map((e) => e.downstream)).toEqual([...NEW_DIMS].sort());
  });
});
