import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import { MockMarketDataAdapter } from '../../src/marketdata/mock-market-data.adapter';
import { SyncRunRecorder } from '../../src/marketdata/sync-run.recorder';
import { SyncTierRecalc } from '../../src/marketdata/sync-tier-recalc';
import { SyncUniverseUseCase } from '../../src/marketdata/sync-universe.usecase';
import { SyncProfileUseCase } from '../../src/marketdata/sync-profile.usecase';
import { DimensionExecutorRegistry } from '../../src/marketdata/dimension-executor';
import type { IndexMembershipPort } from '../../src/marketdata/index-membership.port';
import type { IndexMembershipDto } from '../../src/marketdata/marketdata.types';

const NOW = new Date('2026-06-03T12:00:00Z');
const AS_OF = '2026-06-03';
// index_membership 第 3 形态: 无 mode 分支 / 无 date (恒取当前快照覆盖式). mode 值不影响行为, 用 delta。
const runInput = { mode: 'delta' as const, asOf: AS_OF, now: NOW };

// 039 T016 US3 所属指数集成 IT (Testcontainers PG, test-local mock hk 埋 calls + 可变 snapshot):
// index_membership hk 经 executor 覆盖式落 (instrumentId,indexCode) 当前所属集合 + 第二次不同集合 →
// deleteMany+createMany 反映最新 (旧归属消失、新归属在) + 幂等连跑同集合不翻倍 + per-stock 单 symbol (无 date)。
// 覆盖 state_branch: 所属指数快照覆盖。
describe('039 T016 index_membership 覆盖式快照 (Testcontainers PG, mock hk)', () => {
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

  beforeEach(async () => {
    await prisma.indexMembership.deleteMany();
    await prisma.instrument.deleteMany();
    await prisma.syncRun.deleteMany();
    // T002 migration 已 seed marketScope={hk}; 显式复位保各例独立。
    await prisma.syncDimension.updateMany({
      where: { dimensionKey: 'index_membership' },
      data: { marketScope: ['hk'] },
    });
  });

  /**
   * test-local hk index_membership adapter: 记 calls (验 per-stock 单 symbol + 无 range 入参); served
   * 集内标的返当前可变 snapshot (覆盖式测试可在两次 run 间改集合), 集外 → []。
   */
  class HkIndexMembershipMock implements IndexMembershipPort {
    readonly calls: string[] = [];
    snapshot: IndexMembershipDto[];
    constructor(
      private readonly served: ReadonlySet<string>,
      snapshot: IndexMembershipDto[],
    ) {
      this.snapshot = snapshot;
    }
    async getIndexMembership(symbol: string): Promise<IndexMembershipDto[]> {
      this.calls.push(symbol);
      if (!this.served.has(symbol)) return [];
      return this.snapshot;
    }
  }

  function buildRegistry(indexMembership: IndexMembershipPort): DimensionExecutorRegistry {
    const mock = new MockMarketDataAdapter();
    return new DimensionExecutorRegistry(
      new SyncUniverseUseCase(mock, prisma),
      new SyncProfileUseCase(mock, prisma),
      mock,
      mock,
      mock,
      mock,
      prisma,
      new SyncRunRecorder(prisma),
      new SyncTierRecalc(prisma),
      undefined, // backfillPacer → 默认 disabled()
      mock, // shortSelling
      mock, // connectHolding
      mock, // fundHolding
      mock, // fundCompanyHolding
      indexMembership,
    );
  }

  async function seedHk(code: string, name: string): Promise<bigint> {
    const inst = await prisma.instrument.create({
      data: {
        market: 'hk',
        code,
        name,
        type: 'stock',
        currency: 'HKD',
        status: 'active',
        lixingerCompanyType: 'non',
      },
    });
    return inst.id;
  }

  const idx = (indexCode: string, name: string): IndexMembershipDto => ({
    indexCode,
    name,
    source: 'lxri',
    areaCode: 'hk',
  });

  // ── ① 落当前所属集合: 无 date 快照 → (instrumentId,indexCode) 多行 + per-stock 单 symbol ──
  it('① index_membership hk → 落当前所属集合 (instrumentId,indexCode) 多行 + per-stock 单 symbol (无 date)', async () => {
    const instId = await seedHk('00700', '腾讯控股');
    const indexMembership = new HkIndexMembershipMock(new Set(['hk:00700']), [
      idx('1000001', '恒生指数'),
      idx('1000015', '港股全指'),
    ]);
    const registry = buildRegistry(indexMembership);

    const { stats } = await registry.execute('index_membership', runInput);

    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
    // per-stock 单 symbol (executor 层「单数 stockCode」, 无 range/date)。
    expect(indexMembership.calls).toEqual(['hk:00700']);

    const rows = await prisma.indexMembership.findMany({
      where: { instrumentId: instId },
      orderBy: { indexCode: 'asc' },
    });
    expect(rows.map((r) => r.indexCode)).toEqual(['1000001', '1000015']);
    expect(rows[0]).toMatchObject({
      indexCode: '1000001',
      name: '恒生指数',
      source: 'lxri',
      areaCode: 'hk',
    });

    const run = await prisma.syncRun.findFirstOrThrow({
      where: { syncType: 'sync:index_membership' },
    });
    expect(run.status).toBe('success');
  });

  // ── ② 覆盖式: 第二次不同集合 → 反映最新 (旧归属消失、新归属在) ──
  it('② 覆盖式: 第二次归属集合变化 → deleteMany+createMany 反映最新 (旧归属删、新归属在)', async () => {
    const instId = await seedHk('00700', '腾讯控股');
    // 首次集合 A: {1000001 恒生, 1000015 港股全指}。
    const indexMembership = new HkIndexMembershipMock(new Set(['hk:00700']), [
      idx('1000001', '恒生指数'),
      idx('1000015', '港股全指'),
    ]);
    const registry = buildRegistry(indexMembership);
    await registry.execute('index_membership', runInput);
    expect(
      (await prisma.indexMembership.findMany({ where: { instrumentId: instId } })).map(
        (r) => r.indexCode,
      ),
    ).toEqual(expect.arrayContaining(['1000001', '1000015']));

    // 第二次集合 B: 去掉 1000015 (旧归属), 加 1000099 (新归属); 保留 1000001。
    indexMembership.snapshot = [idx('1000001', '恒生指数'), idx('1000099', '恒生科技指数')];
    await registry.execute('index_membership', runInput);

    const rows = await prisma.indexMembership.findMany({
      where: { instrumentId: instId },
      orderBy: { indexCode: 'asc' },
    });
    // 覆盖式: 反映最新集合 B —— 旧归属 1000015 消失, 新归属 1000099 在, 交集 1000001 保留。
    expect(rows.map((r) => r.indexCode)).toEqual(['1000001', '1000099']);
    expect(rows.find((r) => r.indexCode === '1000015')).toBeUndefined(); // 旧归属被删
    expect(rows.find((r) => r.indexCode === '1000099')?.name).toBe('恒生科技指数'); // 新归属落库
  });

  // ── ③ 幂等: 同集合连跑两次 → 覆盖式不翻倍 (deleteMany 清 + createMany 灌, 自然键唯一) ──
  it('③ 幂等: index_membership 同集合连跑两次 → 不翻倍', async () => {
    const instId = await seedHk('00700', '腾讯控股');
    const indexMembership = new HkIndexMembershipMock(new Set(['hk:00700']), [
      idx('1000001', '恒生指数'),
      idx('1000015', '港股全指'),
    ]);
    const registry = buildRegistry(indexMembership);

    await registry.execute('index_membership', runInput);
    await registry.execute('index_membership', runInput);

    expect(await prisma.indexMembership.count({ where: { instrumentId: instId } })).toBe(2);
  });
});
