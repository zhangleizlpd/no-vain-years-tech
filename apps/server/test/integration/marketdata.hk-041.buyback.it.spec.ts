import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import { MockMarketDataAdapter } from '../../src/marketdata/mock-market-data.adapter';
import { SyncRunRecorder } from '../../src/marketdata/sync-run.recorder';
import { SyncTierRecalc } from '../../src/marketdata/sync-tier-recalc';
import { SyncUniverseUseCase } from '../../src/marketdata/sync-universe.usecase';
import { SyncProfileUseCase } from '../../src/marketdata/sync-profile.usecase';
import { DimensionExecutorRegistry } from '../../src/marketdata/dimension-executor';
import type { BuybackPort } from '../../src/marketdata/buyback.port';
import type { BuybackDto, BuybackRangeQuery } from '../../src/marketdata/marketdata.types';

const NOW = new Date('2026-06-03T12:00:00Z');
const AS_OF = '2026-06-03';
// backfill 不传 backfillHistoryDays → from 由 seed historyDepth(3650, ~10yr) 驱动 (事件流可回填历史)。
const backfillInput = { mode: 'backfill' as const, asOf: AS_OF, now: NOW };

// 多年回购事件 fixture (跨年, date 升序; typed 列齐: num/totalSharesFor* BigInt, highestPrice/
// lowestPrice/avgPrice/totalPaid/ratioPurchasedSinceResolution Decimal, methodOfPurchase/currency/
// boardType 文本)。末行 = p3 探查报告实测 hk:00700 2024-12-30。
const MULTI_YEAR_ROWS: BuybackDto[] = [
  {
    date: '2016-06-15',
    vendorEventId: 'bb-2016-0001',
    num: '1000000',
    highestPrice: '210.0',
    lowestPrice: '205.0',
    avgPrice: '207.5',
    totalPaid: '207500000',
    totalSharesForCancellation: '1000000',
    totalSharesForTreasury: '0',
    ratioPurchasedSinceResolution: '0.010000',
    methodOfPurchase: 'exchange',
    currency: 'HKD',
    boardType: 'main',
  },
  {
    date: '2020-06-15',
    vendorEventId: 'bb-2020-0001',
    num: '1200000',
    highestPrice: '320.0',
    lowestPrice: '315.0',
    avgPrice: '317.5',
    totalPaid: '381000000',
    totalSharesForCancellation: '1200000',
    totalSharesForTreasury: '0',
    ratioPurchasedSinceResolution: '0.015000',
    methodOfPurchase: 'exchange',
    currency: 'HKD',
    boardType: 'main',
  },
  {
    date: '2024-12-30',
    vendorEventId: '68f6e365d5961364e4428dce',
    num: '1370000',
    highestPrice: '421.4',
    lowestPrice: '416.0',
    avgPrice: '419.004',
    totalPaid: '574035480',
    totalSharesForCancellation: '1370000',
    totalSharesForTreasury: '0',
    ratioPurchasedSinceResolution: '0.024450',
    methodOfPurchase: 'exchange',
    currency: 'HKD',
    boardType: 'main',
  },
];

// 041 T006 US1 回购事件集成 IT (Testcontainers PG, test-local mock hk 埋 rangeCalls):
// buyback hk backfill 经 executor 区间模式落 (instrumentId,date) 多年事件行 (typed 列齐) + 连跑幂等
// (createMany skipDuplicates 自然键) + 请求单数 stockCode + range (from<to) + from=asOf−10yr (seed
// historyDepth 驱动) + 空返回零行不崩 + marketScope={hk} 纳 hk 排除 cn + C1 扩键同日多笔: 同 (instrumentId,date)
// 不同 vendorEventId 两笔都落 (照汇丰同日两市场回购) + 同 vendorEventId 重同步折叠幂等。用 test-local mock hk adapter (非扩共享 MockMarketDataAdapter,
// 后者 hk=no-data 护 seam); 落库经真 PG。覆盖 state_branch: 回购事件回填 / 全部单数 stockCode+range 契约(buyback)
// / 事件流可回填历史(buyback) / 4 维度 marketScope 纳入。
describe('041 T006 buyback 回购事件 (Testcontainers PG, mock hk)', () => {
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
    await prisma.buybackEvent.deleteMany();
    await prisma.instrument.deleteMany();
    await prisma.syncRun.deleteMany();
    // T002 migration seed 已把 buyback marketScope={hk} / historyDepth=3650; 显式复位保各例独立。
    await prisma.syncDimension.updateMany({
      where: { dimensionKey: 'buyback' },
      data: { marketScope: ['hk'], historyDepth: 3650 },
    });
  });

  /**
   * test-local hk buyback adapter: 记 rangeCalls (验请求走区间 + per-stock 单 symbol);
   * served 集内标的返给定 rows (缺省多年跨年事件), 集外 → [] (无回购历史标的)。
   */
  class HkBuybackMock implements BuybackPort {
    readonly rangeCalls: BuybackRangeQuery[] = [];
    constructor(
      private readonly served: ReadonlySet<string>,
      private readonly rows: BuybackDto[] = MULTI_YEAR_ROWS,
    ) {}
    async getBuybackRange(query: BuybackRangeQuery): Promise<BuybackDto[]> {
      this.rangeCalls.push(query);
      if (!this.served.has(query.symbol)) return [];
      return this.rows;
    }
  }

  function buildRegistry(opts: { buyback?: BuybackPort } = {}): DimensionExecutorRegistry {
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
      undefined, // shortSelling → 默认 null-object
      undefined, // connectHolding → 默认 null-object
      undefined, // fundHolding → 默认 null-object
      undefined, // fundCompanyHolding → 默认 null-object
      undefined, // indexMembership → 默认 null-object
      undefined, // volatility → 默认 null-object
      undefined, // hotSnapshot → 默认 null-object
      opts.buyback ?? mock, // buyback (尾部)
    );
  }

  async function seedInst(market: string, code: string, name: string): Promise<bigint> {
    const inst = await prisma.instrument.create({
      data: {
        market,
        code,
        name,
        type: 'stock',
        currency: market === 'hk' ? 'HKD' : 'CNY',
        status: 'active',
        lixingerCompanyType: 'non',
      },
    });
    return inst.id;
  }

  // ── ① buyback hk 区间回填: 多年事件 + typed 列齐 + 请求单数 stockCode + range (from<to) ──
  it('① buyback hk backfill → buyback_event (instrumentId,date) 多年事件 typed 列齐 + 请求单数 stockCode + range', async () => {
    const instId = await seedInst('hk', '00700', '腾讯控股');
    const buyback = new HkBuybackMock(new Set(['hk:00700']));
    const registry = buildRegistry({ buyback });

    const { stats } = await registry.execute('buyback', backfillInput);

    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
    // 请求走区间 (from<to) + per-stock 单 symbol (executor 层「单数 stockCode」契约)。
    expect(buyback.rangeCalls).toHaveLength(1);
    const q = buyback.rangeCalls[0];
    expect(q.symbol).toBe('hk:00700');
    expect(Boolean(q.from && q.to && q.from < q.to)).toBe(true);

    const rows = await prisma.buybackEvent.findMany({
      where: { instrumentId: instId },
      orderBy: { date: 'asc' },
    });
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.date.toISOString().slice(0, 10))).toEqual([
      '2016-06-15',
      '2020-06-15',
      '2024-12-30',
    ]);
    // typed 列齐 (末行 2024-12-30): num/totalShares → BigInt, 价格/金额/比率 → Decimal, 文本列。
    const last = rows[2];
    expect(last.num).toBe(1370000n); // BigInt? 股数列
    expect(last.totalSharesForCancellation).toBe(1370000n);
    expect(last.totalSharesForTreasury).toBe(0n);
    expect(Number(last.avgPrice)).toBe(419.004); // Decimal(18,4)
    expect(Number(last.totalPaid)).toBe(574035480); // Decimal(24,2)
    expect(Number(last.ratioPurchasedSinceResolution)).toBe(0.02445); // Decimal(20,6)
    expect(last.methodOfPurchase).toBe('exchange');
    expect(last.currency).toBe('HKD');
    expect(last.boardType).toBe('main');

    const run = await prisma.syncRun.findFirstOrThrow({ where: { syncType: 'sync:buyback' } });
    expect(run.status).toBe('success');
  });

  // ── ② from=asOf−10yr: 事件流可回填历史 (seed historyDepth=3650 驱动, 未传 backfillHistoryDays) ──
  it('② buyback backfill from=asOf−historyDepth(3650, ~10yr) — seed historyDepth 驱动可回填历史', async () => {
    await seedInst('hk', '00700', '腾讯控股');
    const buyback = new HkBuybackMock(new Set(['hk:00700']));
    const registry = buildRegistry({ buyback });

    await registry.execute('buyback', backfillInput);

    const q = buyback.rangeCalls[0];
    expect(q.to).toBe(AS_OF); // to = asOf
    const gapDays = (new Date(q.to as string).getTime() - new Date(q.from).getTime()) / 86_400_000;
    expect(Math.round(gapDays)).toBe(3650); // from = asOf − seed historyDepth (~10yr)
  });

  // ── ③ 幂等: backfill 连跑两次 → createMany skipDuplicates 不翻倍 (自然键 instrumentId,date) ──
  it('③ 幂等: buyback backfill 连跑两次 → 自然键 (instrumentId,date) 不翻倍', async () => {
    const instId = await seedInst('hk', '00700', '腾讯控股');
    const buyback = new HkBuybackMock(new Set(['hk:00700']));
    const registry = buildRegistry({ buyback });

    await registry.execute('buyback', backfillInput);
    await registry.execute('buyback', backfillInput);

    expect(await prisma.buybackEvent.count({ where: { instrumentId: instId } })).toBe(3);
  });

  // ── ④ 空返回零行不崩: 无回购历史标的 vendor 返 [] → 零落库、ok 非 failed、不阻塞 ──
  it('④ 无回购历史标的返 [] → 不写库、ok 非 failed、不阻塞其余标的 (per-stock 单 symbol)', async () => {
    const withHist = await seedInst('hk', '00700', '腾讯控股'); // 有回购史 (served)
    const noHist = await seedInst('hk', '08001', '和记电讯香港'); // 无回购史 (not served)
    const buyback = new HkBuybackMock(new Set(['hk:00700']));
    const registry = buildRegistry({ buyback });

    const { stats } = await registry.execute('buyback', backfillInput);

    // 两标的都 scanned+ok (08001 空返回不计 failed, 不阻塞 00700)。
    expect(stats).toMatchObject({ scanned: 2, ok: 2, failed: 0 });
    // per-stock 单 symbol: 2 标的 → 2 独立 rangeCall, 各单 symbol (非批量)。
    expect(buyback.rangeCalls).toHaveLength(2);
    expect(buyback.rangeCalls.map((c) => c.symbol).sort()).toEqual(['hk:00700', 'hk:08001']);
    expect(await prisma.buybackEvent.count({ where: { instrumentId: withHist } })).toBe(3);
    expect(await prisma.buybackEvent.count({ where: { instrumentId: noHist } })).toBe(0);
  });

  // ── ⑤ marketScope={hk}: 纳 hk 排除 cn (4 维度 marketScope 纳入) ──
  it('⑤ marketScope={hk} → 纳 hk 排除 cn (cn 标的不进工作集、零 rangeCall、零落库)', async () => {
    const hkId = await seedInst('hk', '00700', '腾讯控股');
    const cnId = await seedInst('cn', '600519', '贵州茅台');
    const buyback = new HkBuybackMock(new Set(['hk:00700', 'cn:600519']));
    const registry = buildRegistry({ buyback });

    const { stats } = await registry.execute('buyback', backfillInput);

    // marketScope={hk} → 仅 hk 进工作集; cn 被排除 (即便 served 也不请求)。
    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
    expect(buyback.rangeCalls.map((c) => c.symbol)).toEqual(['hk:00700']);
    expect(await prisma.buybackEvent.count({ where: { instrumentId: hkId } })).toBe(3);
    expect(await prisma.buybackEvent.count({ where: { instrumentId: cnId } })).toBe(0);
  });

  // ── ⑥ 同日多笔 (C1 扩键): 同 (instrumentId,date) 不同 vendorEventId → 两笔都落 (照汇丰 00005 同日两市场回购) ──
  it('⑥ 同日多笔: 同 (instrumentId,date) 不同 vendorEventId → 两笔都落 (C1 扩键防丢真行, 照汇丰同日两市场回购)', async () => {
    const instId = await seedInst('hk', '00005', '汇丰控股');
    // 汇丰 2025-10-17 同日两笔: GBP/turquoise + HKD/exchange (两市场回购, 探针实证同日多事件)。
    const sameDayRows: BuybackDto[] = [
      {
        ...MULTI_YEAR_ROWS[2],
        date: '2025-10-17',
        vendorEventId: '68f6e365d5961364e4428dcd',
        currency: 'GBP',
        methodOfPurchase: 'turquoise',
        num: '100000',
      },
      {
        ...MULTI_YEAR_ROWS[2],
        date: '2025-10-17',
        vendorEventId: '68f6e365d5961364e4428dce',
        currency: 'HKD',
        methodOfPurchase: 'exchange',
        num: '200000',
      },
    ];
    const buyback = new HkBuybackMock(new Set(['hk:00005']), sameDayRows);
    const registry = buildRegistry({ buyback });

    const { stats } = await registry.execute('buyback', backfillInput);

    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
    // C1 自然键 (instrumentId,date,vendorEventId): 同日不同 vendorEventId → 两笔各落 (不折叠丢行)。
    const rows = await prisma.buybackEvent.findMany({
      where: { instrumentId: instId },
      orderBy: { vendorEventId: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.vendorEventId)).toEqual([
      '68f6e365d5961364e4428dcd',
      '68f6e365d5961364e4428dce',
    ]);
    expect(rows.map((r) => r.currency).sort()).toEqual(['GBP', 'HKD']);
  });

  // ── ⑦ 同 vendorEventId 重同步幂等: 相同 (instrumentId,date,vendorEventId) 连跑 → skipDuplicates 折叠不翻倍 ──
  it('⑦ 同 vendorEventId 重同步 → skipDuplicates 折叠幂等 (连跑两次不翻倍)', async () => {
    const instId = await seedInst('hk', '00005', '汇丰控股');
    const sameEvent: BuybackDto[] = [
      { ...MULTI_YEAR_ROWS[2], date: '2025-10-17', vendorEventId: 'dup-same-id', num: '100000' },
    ];
    const buyback = new HkBuybackMock(new Set(['hk:00005']), sameEvent);
    const registry = buildRegistry({ buyback });

    await registry.execute('buyback', backfillInput);
    await registry.execute('buyback', backfillInput); // 重同步同 vendorEventId

    const rows = await prisma.buybackEvent.findMany({ where: { instrumentId: instId } });
    expect(rows).toHaveLength(1); // 同 vendorEventId → 折叠幂等 (ON CONFLICT DO NOTHING)
  });
});
