import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import { MockMarketDataAdapter } from '../../src/marketdata/mock-market-data.adapter';
import { SyncRunRecorder } from '../../src/marketdata/sync-run.recorder';
import { SyncTierRecalc } from '../../src/marketdata/sync-tier-recalc';
import { SyncUniverseUseCase } from '../../src/marketdata/sync-universe.usecase';
import { SyncProfileUseCase } from '../../src/marketdata/sync-profile.usecase';
import { DimensionExecutorRegistry } from '../../src/marketdata/dimension-executor';
import type { FundHoldingPort } from '../../src/marketdata/fund-holding.port';
import type { FundCompanyHoldingPort } from '../../src/marketdata/fund-company-holding.port';
import type {
  FundCompanyHoldingDto,
  FundCompanyHoldingRangeQuery,
  FundHoldingDto,
  FundHoldingRangeQuery,
} from '../../src/marketdata/marketdata.types';

const NOW = new Date('2026-06-03T12:00:00Z');
const AS_OF = '2026-06-03';
// backfillHistoryDays 缺省 → executor 回退 dim.historyDepth (seed=1825, 近 5 年); 验真 seed→executor
// 路径用 1825 而非 10yr (T013 「非 10yr」)。
const backfillInput = { mode: 'backfill' as const, asOf: AS_OF, now: NOW };

// 039 T013 US2 机构持仓集成 IT (Testcontainers PG, test-local mock hk 埋 rangeCalls):
// fund_holding / fund_company_holding hk backfill 经 executor 报告期区间模式落 (instrumentId,reportDate,
// fundCode/fundCollectionCode) 多行 (报告期×基金) + from=asOf−5yr (seed historyDepth=1825, 非 10yr) +
// vendor 字段缺失存 null 不崩 + 连跑幂等 (createMany skipDuplicates 自然键不翻倍) + per-stock 单 symbol。
// 覆盖 state_branch: 公募基金持股报告期回填 / 基金公司持股报告期回填 / vendor 字段缺失存 null /
// param 单数 stockCode (executor)。
describe('039 T013 fund_holding/fund_company_holding 报告期 (Testcontainers PG, mock hk)', () => {
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
    await prisma.fundHolding.deleteMany();
    await prisma.fundCompanyHolding.deleteMany();
    await prisma.instrument.deleteMany();
    await prisma.syncRun.deleteMany();
    // T002 migration 已 seed 两维度 marketScope={hk}/history_depth=1825; 显式复位 marketScope 保各例独立
    // (history_depth 不动 → from 计算仍取 seed 1825)。
    await prisma.syncDimension.updateMany({
      where: { dimensionKey: { in: ['fund_holding', 'fund_company_holding'] } },
      data: { marketScope: ['hk'] },
    });
  });

  /**
   * test-local hk fund_holding adapter: 记 rangeCalls (验区间 + per-stock 单 symbol); served 集内标的
   * 返 3 行 (2 报告期 × 基金, 含一行缺字段 marketCapRank/declarationDate/marketCap null), 集外 → []。
   */
  class HkFundHoldingMock implements FundHoldingPort {
    readonly rangeCalls: FundHoldingRangeQuery[] = [];
    constructor(private readonly served: ReadonlySet<string>) {}
    async getFundHoldingRange(query: FundHoldingRangeQuery): Promise<FundHoldingDto[]> {
      this.rangeCalls.push(query);
      if (!this.served.has(query.symbol)) return [];
      return [
        {
          reportDate: '2024-03-31',
          fundCode: '513050',
          name: '易方达中证海外中国互联网50',
          holdings: '24158500',
          marketCap: '11080211711',
          netValueRatio: '0.2994',
          marketCapRank: 1,
          declarationDate: '2024-04-22',
          proportionOutstandingSharesA: null,
        },
        {
          reportDate: '2024-03-31',
          fundCode: '110011',
          name: '易方达优质精选',
          holdings: '5000000',
          marketCap: '2000000000',
          netValueRatio: '0.1500',
          marketCapRank: 3,
          declarationDate: '2024-04-25',
          proportionOutstandingSharesA: null,
        },
        {
          // 缺字段行: marketCapRank/declarationDate/marketCap/netValueRatio → null (存 null 不崩)。
          reportDate: '2024-06-30',
          fundCode: '513050',
          name: '易方达中证海外中国互联网50',
          holdings: '26000000',
          marketCap: null,
          netValueRatio: null,
          marketCapRank: null,
          declarationDate: null,
          proportionOutstandingSharesA: null,
        },
      ];
    }
  }

  /** test-local hk fund_company_holding adapter: 2 报告期 (含一行缺 holdings/marketCap null)。 */
  class HkFundCompanyHoldingMock implements FundCompanyHoldingPort {
    readonly rangeCalls: FundCompanyHoldingRangeQuery[] = [];
    constructor(private readonly served: ReadonlySet<string>) {}
    async getFundCompanyHoldingRange(
      query: FundCompanyHoldingRangeQuery,
    ): Promise<FundCompanyHoldingDto[]> {
      this.rangeCalls.push(query);
      if (!this.served.has(query.symbol)) return [];
      return [
        {
          reportDate: '2024-03-31',
          fundCollectionCode: '14240000',
          name: '中信证券资产管理有限公司',
          holdings: '690600',
          marketCap: '320952688',
        },
        {
          // 缺字段行: holdings/marketCap → null。
          reportDate: '2024-06-30',
          fundCollectionCode: '14240000',
          name: '中信证券资产管理有限公司',
          holdings: null,
          marketCap: null,
        },
      ];
    }
  }

  function buildRegistry(opts: {
    fundHolding?: FundHoldingPort;
    fundCompanyHolding?: FundCompanyHoldingPort;
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
      mock, // shortSelling
      mock, // connectHolding
      opts.fundHolding ?? mock,
      opts.fundCompanyHolding ?? mock,
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

  // ── ① fund_holding hk 报告期回填: 报告期×基金多行 + from=asOf−1825 (非 10yr) + per-stock 单 symbol + 缺字段 null ──
  it('① fund_holding hk backfill → fund_holding (instrumentId,reportDate,fundCode) 多行 + from≈asOf−1825 + 缺字段 null', async () => {
    const instId = await seedHk('00700', '腾讯控股');
    const fundHolding = new HkFundHoldingMock(new Set(['hk:00700']));
    const registry = buildRegistry({ fundHolding });

    const { stats } = await registry.execute('fund_holding', backfillInput);

    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
    // 请求走区间 (from<to) + per-stock 单 symbol (executor 层「单数 stockCode」) + from=asOf−5yr (seed 1825, 非 10yr)。
    expect(fundHolding.rangeCalls).toHaveLength(1);
    const q = fundHolding.rangeCalls[0];
    expect(q.symbol).toBe('hk:00700');
    expect(q.to).toBe(AS_OF);
    const gapDays = (new Date(q.to as string).getTime() - new Date(q.from).getTime()) / 86_400_000;
    expect(Math.round(gapDays)).toBe(1825); // 近 5 年, 非 10yr

    const rows = await prisma.fundHolding.findMany({
      where: { instrumentId: instId },
      orderBy: [{ reportDate: 'asc' }, { fundCode: 'asc' }],
    });
    expect(rows).toHaveLength(3); // 报告期×基金 (2024Q1 × 2 基金 + 2024Q2 × 1 基金)
    // 全字段行 (2024-03-31, 110011): fundCode 排序在 513050 前。
    const full = rows[0];
    expect(full.reportDate.toISOString().slice(0, 10)).toBe('2024-03-31');
    expect(full.fundCode).toBe('110011');
    expect(full.holdings?.toString()).toBe('5000000');
    expect(full.marketCapRank).toBe(3);
    expect(full.declarationDate?.toISOString().slice(0, 10)).toBe('2024-04-25');
    // 缺字段行 (2024-06-30, 513050): marketCap/netValueRatio/marketCapRank/declarationDate 存 null。
    const partial = rows.find((r) => r.reportDate.toISOString().slice(0, 10) === '2024-06-30');
    expect(partial).toBeDefined();
    expect(partial!.holdings?.toString()).toBe('26000000');
    expect(partial!.marketCap).toBeNull();
    expect(partial!.netValueRatio).toBeNull();
    expect(partial!.marketCapRank).toBeNull();
    expect(partial!.declarationDate).toBeNull();

    const run = await prisma.syncRun.findFirstOrThrow({ where: { syncType: 'sync:fund_holding' } });
    expect(run.status).toBe('success');
  });

  // ── ② fund_company_holding hk 报告期回填: 报告期×基金公司多行 + from≈asOf−1825 + 缺字段 null ──
  it('② fund_company_holding hk backfill → fund_company_holding (instrumentId,reportDate,fundCollectionCode) 多行 + 缺字段 null', async () => {
    const instId = await seedHk('00700', '腾讯控股');
    const fundCompanyHolding = new HkFundCompanyHoldingMock(new Set(['hk:00700']));
    const registry = buildRegistry({ fundCompanyHolding });

    const { stats } = await registry.execute('fund_company_holding', backfillInput);

    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
    expect(fundCompanyHolding.rangeCalls).toHaveLength(1);
    expect(fundCompanyHolding.rangeCalls[0].symbol).toBe('hk:00700');
    const q = fundCompanyHolding.rangeCalls[0];
    const gapDays = (new Date(q.to as string).getTime() - new Date(q.from).getTime()) / 86_400_000;
    expect(Math.round(gapDays)).toBe(1825);

    const rows = await prisma.fundCompanyHolding.findMany({
      where: { instrumentId: instId },
      orderBy: { reportDate: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].fundCollectionCode).toBe('14240000');
    expect(rows[0].holdings?.toString()).toBe('690600');
    // 缺字段行 (2024-06-30): holdings/marketCap null。
    expect(rows[1].reportDate.toISOString().slice(0, 10)).toBe('2024-06-30');
    expect(rows[1].holdings).toBeNull();
    expect(rows[1].marketCap).toBeNull();

    const run = await prisma.syncRun.findFirstOrThrow({
      where: { syncType: 'sync:fund_company_holding' },
    });
    expect(run.status).toBe('success');
  });

  // ── ③ 幂等: backfill 连跑两次 → createMany skipDuplicates 不翻倍 (自然键报告期×基金/基金公司) ──
  it('③ 幂等: fund_holding/fund_company_holding backfill 连跑两次 → 自然键不翻倍', async () => {
    const instId = await seedHk('00700', '腾讯控股');
    const fundHolding = new HkFundHoldingMock(new Set(['hk:00700']));
    const fundCompanyHolding = new HkFundCompanyHoldingMock(new Set(['hk:00700']));
    const registry = buildRegistry({ fundHolding, fundCompanyHolding });

    await registry.execute('fund_holding', backfillInput);
    await registry.execute('fund_holding', backfillInput);
    await registry.execute('fund_company_holding', backfillInput);
    await registry.execute('fund_company_holding', backfillInput);

    expect(await prisma.fundHolding.count({ where: { instrumentId: instId } })).toBe(3);
    expect(await prisma.fundCompanyHolding.count({ where: { instrumentId: instId } })).toBe(2);
  });
});
