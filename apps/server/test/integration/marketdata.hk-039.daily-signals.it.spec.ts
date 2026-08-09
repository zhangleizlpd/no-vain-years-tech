import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import { MockMarketDataAdapter } from '../../src/marketdata/mock-market-data.adapter';
import { SyncRunRecorder } from '../../src/marketdata/sync-run.recorder';
import { SyncTierRecalc } from '../../src/marketdata/sync-tier-recalc';
import { SyncUniverseUseCase } from '../../src/marketdata/sync-universe.usecase';
import { SyncProfileUseCase } from '../../src/marketdata/sync-profile.usecase';
import { DimensionExecutorRegistry } from '../../src/marketdata/dimension-executor';
import type { ShortSellingPort } from '../../src/marketdata/short-selling.port';
import type { ConnectHoldingPort } from '../../src/marketdata/connect-holding.port';
import type {
  ConnectHoldingPoint,
  ConnectHoldingRangeQuery,
  ShortSellingPoint,
  ShortSellingRangeQuery,
} from '../../src/marketdata/marketdata.types';

const NOW = new Date('2026-06-03T12:00:00Z');
const AS_OF = '2026-06-03';
const backfillInput = {
  mode: 'backfill' as const,
  asOf: AS_OF,
  now: NOW,
  backfillHistoryDays: 3650, // ≤10yr 区间
};

// 039 T008 US1 日频高信号集成 IT (Testcontainers PG, test-local mock hk 埋 rangeCalls):
// short_selling / connect_holding hk backfill 经 executor 区间模式落 (instrumentId,date) 多行日频 +
// 连跑幂等 (createMany skipDuplicates 自然键) + 非港股通标的空返回容错 (零落库不崩不阻塞) +
// per-stock 单 symbol 请求 (executor 层「单数 stockCode」)。用 test-local mock hk adapter (非扩共享
// MockMarketDataAdapter, 后者 hk=no-data 护 seam); 落库经真 PG。覆盖 state_branch: 做空/南向 hk 日频
// 回填 / 南向非成分标的空数据 / param 单数 stockCode (executor) / 5 维度 marketScope 纳入。
describe('039 T008 short_selling/connect_holding 日频 (Testcontainers PG, mock hk)', () => {
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
    await prisma.shortSellingDaily.deleteMany();
    await prisma.connectHoldingDaily.deleteMany();
    await prisma.instrument.deleteMany();
    await prisma.syncRun.deleteMany();
    // T002 migration seed 已把 short_selling/connect_holding marketScope={hk}; 显式复位保各例独立。
    await prisma.syncDimension.updateMany({
      where: { dimensionKey: { in: ['short_selling', 'connect_holding'] } },
      data: { marketScope: ['hk'] },
    });
  });

  /**
   * test-local hk short_selling adapter: 记 rangeCalls (验请求走区间 + per-stock 单 symbol);
   * served 集内标的返 3 行跨年日频, 集外 → [] (无做空数据标的)。
   */
  class HkShortSellingMock implements ShortSellingPort {
    readonly rangeCalls: ShortSellingRangeQuery[] = [];
    constructor(private readonly served: ReadonlySet<string>) {}
    async getShortSellingRange(query: ShortSellingRangeQuery): Promise<ShortSellingPoint[]> {
      this.rangeCalls.push(query);
      if (!this.served.has(query.symbol)) return [];
      return ['2016-06-15', '2020-06-15', '2026-05-15'].map((date, i) => ({
        date,
        shares: `${1831500 + i}`,
        amount: `${915201080 + i}.00`,
      }));
    }
  }

  /** test-local hk connect_holding adapter: served 集 = 港股通标的 (返 2 行); 集外 = 非港股通 → []。 */
  class HkConnectHoldingMock implements ConnectHoldingPort {
    readonly rangeCalls: ConnectHoldingRangeQuery[] = [];
    constructor(private readonly served: ReadonlySet<string>) {}
    async getConnectHoldingRange(query: ConnectHoldingRangeQuery): Promise<ConnectHoldingPoint[]> {
      this.rangeCalls.push(query);
      if (!this.served.has(query.symbol)) return [];
      return ['2020-06-15', '2020-06-16'].map((date, i) => ({
        date,
        shareholdings: `${1039052782 + i}`,
      }));
    }
  }

  function buildRegistry(opts: {
    shortSelling?: ShortSellingPort;
    connectHolding?: ConnectHoldingPort;
  }): DimensionExecutorRegistry {
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
      opts.shortSelling ?? mock,
      opts.connectHolding ?? mock,
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

  // ── ① short_selling hk 区间回填: 多行日频 + 请求走区间 (from<to) ────────────────
  it('① short_selling hk backfill → short_selling_daily (instrumentId,date) 多行日频 + 请求走区间', async () => {
    const instId = await seedHk('00700', '腾讯控股');
    const shortSelling = new HkShortSellingMock(new Set(['hk:00700']));
    const registry = buildRegistry({ shortSelling });

    const { stats } = await registry.execute('short_selling', backfillInput);

    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
    // 请求走区间 (from<to) + per-stock 单 symbol (executor 层「单数 stockCode」)。
    expect(shortSelling.rangeCalls).toHaveLength(1);
    const q = shortSelling.rangeCalls[0];
    expect(q.symbol).toBe('hk:00700');
    expect(Boolean(q.from && q.to && q.from < q.to)).toBe(true);

    const rows = await prisma.shortSellingDaily.findMany({
      where: { instrumentId: instId },
      orderBy: { date: 'asc' },
    });
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.date.toISOString().slice(0, 10))).toEqual([
      '2016-06-15',
      '2020-06-15',
      '2026-05-15',
    ]);
    expect(rows[0].shares?.toString()).toBe('1831500');
    expect(rows[0].amount?.toString()).toBe('915201080');
    const run = await prisma.syncRun.findFirstOrThrow({
      where: { syncType: 'sync:short_selling' },
    });
    expect(run.status).toBe('success');
  });

  // ── ② connect_holding hk 区间回填: 港股通标的多行日频 ──────────────────────────
  it('② connect_holding hk backfill (港股通标的) → connect_holding_daily 多行日频', async () => {
    const instId = await seedHk('00700', '腾讯控股');
    const connectHolding = new HkConnectHoldingMock(new Set(['hk:00700']));
    const registry = buildRegistry({ connectHolding });

    const { stats } = await registry.execute('connect_holding', backfillInput);

    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
    expect(connectHolding.rangeCalls).toHaveLength(1);
    expect(connectHolding.rangeCalls[0].symbol).toBe('hk:00700');

    const rows = await prisma.connectHoldingDaily.findMany({
      where: { instrumentId: instId },
      orderBy: { date: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].shareholdings?.toString()).toBe('1039052782');
    const run = await prisma.syncRun.findFirstOrThrow({
      where: { syncType: 'sync:connect_holding' },
    });
    expect(run.status).toBe('success');
  });

  // ── ③ 南向非成分标的空数据: 非港股通标的返 [] → 零落库、ok 非 failed、不阻塞港股通标的 ──
  it('③ connect_holding 非港股通标的返 [] → 不写库、ok 非 failed、不阻塞其余标的 (per-stock 单 symbol)', async () => {
    const inConnect = await seedHk('00700', '腾讯控股'); // 港股通 (served)
    const nonConnect = await seedHk('08001', '和记电讯香港'); // 非港股通 (not served)
    const connectHolding = new HkConnectHoldingMock(new Set(['hk:00700']));
    const registry = buildRegistry({ connectHolding });

    const { stats } = await registry.execute('connect_holding', backfillInput);

    // 两标的都 scanned+ok (08001 空返回不计 failed, 不阻塞 00700)。
    expect(stats).toMatchObject({ scanned: 2, ok: 2, failed: 0 });
    // per-stock 单 symbol: 2 标的 → 2 独立 rangeCall, 各单 symbol (非批量)。
    expect(connectHolding.rangeCalls).toHaveLength(2);
    expect(connectHolding.rangeCalls.map((c) => c.symbol).sort()).toEqual(['hk:00700', 'hk:08001']);
    // 只有港股通标的落库; 非港股通零行。
    expect(await prisma.connectHoldingDaily.count({ where: { instrumentId: inConnect } })).toBe(2);
    expect(await prisma.connectHoldingDaily.count({ where: { instrumentId: nonConnect } })).toBe(0);
  });

  // ── ④ 幂等: backfill 连跑两次 → createMany skipDuplicates 不翻倍 (自然键 instrumentId,date) ──
  it('④ 幂等: short_selling/connect_holding backfill 连跑两次 → 自然键不翻倍', async () => {
    const instId = await seedHk('00700', '腾讯控股');
    const shortSelling = new HkShortSellingMock(new Set(['hk:00700']));
    const connectHolding = new HkConnectHoldingMock(new Set(['hk:00700']));
    const registry = buildRegistry({ shortSelling, connectHolding });

    await registry.execute('short_selling', backfillInput);
    await registry.execute('short_selling', backfillInput);
    await registry.execute('connect_holding', backfillInput);
    await registry.execute('connect_holding', backfillInput);

    expect(await prisma.shortSellingDaily.count({ where: { instrumentId: instId } })).toBe(3);
    expect(await prisma.connectHoldingDaily.count({ where: { instrumentId: instId } })).toBe(2);
  });
});
