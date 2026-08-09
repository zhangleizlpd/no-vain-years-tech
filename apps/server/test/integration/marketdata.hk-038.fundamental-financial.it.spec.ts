import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import { MockMarketDataAdapter } from '../../src/marketdata/mock-market-data.adapter';
import { SyncRunRecorder } from '../../src/marketdata/sync-run.recorder';
import { SyncTierRecalc } from '../../src/marketdata/sync-tier-recalc';
import { SyncUniverseUseCase } from '../../src/marketdata/sync-universe.usecase';
import { SyncProfileUseCase } from '../../src/marketdata/sync-profile.usecase';
import { DimensionExecutorRegistry } from '../../src/marketdata/dimension-executor';
import type { FundamentalPort } from '../../src/marketdata/fundamental.port';
import type { FinancialsPort } from '../../src/marketdata/financials.port';
import type {
  FinancialMetricDto,
  FinancialsRangeQuery,
  FundamentalRangeQuery,
  FundamentalSnapshotDto,
} from '../../src/marketdata/marketdata.types';

const NOW = new Date('2026-06-03T12:00:00Z');
const AS_OF = '2026-06-03';
const backfillInput = {
  mode: 'backfill' as const,
  asOf: AS_OF,
  now: NOW,
  backfillHistoryDays: 3650, // ≤10yr 区间
};

// 038 T014 US2 fundamental / financial 扩 HK 集成 IT (Testcontainers PG, test-local mock hk):
// hk 摄取管线由 T001 (marketScope 工作集) + T013 (per-stock 区间抓取) 缝隙贯通 —— 本 IT 证
// backfill 模式经 T013 区间模式回填 **多行日频估值** (fundamental_snapshot (instrumentId,date))
// + **多期财报** (financial_metric (instrumentId,reportPeriod)), 字段缺失存 null 不崩。
// 用 test-local mock hk adapter (非扩共享 MockMarketDataAdapter, 后者 hk=no-data 护 T006 seam
// IT); 落库/多行/幂等经真 PG。覆盖 state_branch: fundamental/fs hk 区间回填 / vendor 字段缺失存 null。
describe('038 T014 fundamental/financial 扩 HK (Testcontainers PG, mock hk)', () => {
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
    await prisma.fundamentalSnapshot.deleteMany();
    await prisma.financialMetric.deleteMany();
    await prisma.instrument.deleteMany();
    await prisma.syncRun.deleteMany();
    // T003 migration 已把 fundamental/financial 扩 {cn,hk}; 显式复位保各例独立。
    await prisma.syncDimension.updateMany({
      where: { dimensionKey: { in: ['fundamental', 'financial'] } },
      data: { marketScope: ['cn', 'hk'] },
    });
  });

  /**
   * test-local hk fundamental adapter: delta 批量 latest 走 getFundamentals (本 IT backfill 不应调,
   * 调了 = 未走区间, 计数反证); backfill 走 getFundamentalsRange 返 3 个跨年日频行 (多行历史)。
   * dropPctl=true → 分位字段返 null (P2: hk vendor 若不下发分位 → 存 null 不崩)。
   */
  class HkFundamentalMock implements FundamentalPort {
    readonly rangeCalls: FundamentalRangeQuery[] = [];
    latestCallCount = 0;
    constructor(
      private readonly served: ReadonlySet<string>,
      private readonly opts: { dropPctl?: boolean } = {},
    ) {}
    async getFundamentals(symbols: string[]): Promise<FundamentalSnapshotDto[]> {
      this.latestCallCount++;
      void symbols;
      return [];
    }
    async getFundamentalsRange(query: FundamentalRangeQuery): Promise<FundamentalSnapshotDto[]> {
      this.rangeCalls.push(query);
      if (!this.served.has(query.symbol)) return [];
      return ['2016-05-13', '2020-06-15', '2026-05-15'].map((date, i) => ({
        symbol: query.symbol,
        date,
        peTtm: `${20 + i}.5`,
        peStatic: null,
        peDynamic: null,
        pb: '1.2',
        ps: '3.4',
        dividendYield: '0.02',
        marketCap: '1000000000',
        circMarketCap: '900000000',
        pePctlY3: this.opts.dropPctl ? null : '0.42',
        pePctlY5: this.opts.dropPctl ? null : '0.38',
        pbPctlY3: this.opts.dropPctl ? null : '0.55',
        pbPctlY5: this.opts.dropPctl ? null : '0.51',
      }));
    }
  }

  /** test-local hk financials adapter: backfill 走 getFinancialsRange 返 3 期财报 (多期历史)。 */
  class HkFinancialsMock implements FinancialsPort {
    readonly rangeCalls: FinancialsRangeQuery[] = [];
    latestCallCount = 0;
    constructor(private readonly served: ReadonlySet<string>) {}
    async getFinancials(symbols: string[]): Promise<FinancialMetricDto[]> {
      this.latestCallCount++;
      void symbols;
      return [];
    }
    async getFinancialsRange(query: FinancialsRangeQuery): Promise<FinancialMetricDto[]> {
      this.rangeCalls.push(query);
      if (!this.served.has(query.symbol)) return [];
      return ['2024Q4', '2025Q2', '2025Q4'].map((reportPeriod, i) => ({
        symbol: query.symbol,
        reportPeriod,
        roe: `0.2${i}`,
        grossMargin: null, // 金融类无毛利率 → null (缺字段不崩)
        eps: '1.5',
        bps: '10',
      }));
    }
  }

  function buildRegistry(opts: {
    fundamental?: FundamentalPort;
    financials?: FinancialsPort;
  }): DimensionExecutorRegistry {
    const mock = new MockMarketDataAdapter();
    return new DimensionExecutorRegistry(
      new SyncUniverseUseCase(mock, prisma),
      new SyncProfileUseCase(mock, prisma),
      mock,
      opts.fundamental ?? mock,
      opts.financials ?? mock,
      mock,
      prisma,
      new SyncRunRecorder(prisma),
      new SyncTierRecalc(prisma),
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

  // ── ① fundamental hk 区间回填: 多行日频 (非单快照) ────────────────────────────
  it('① fundamental hk backfill → fundamental_snapshot (instrumentId,date) 多行日频历史 (经 T013 区间模式)', async () => {
    const instId = await seedHk('00700', '腾讯控股');
    const fundamental = new HkFundamentalMock(new Set(['hk:00700']));
    const registry = buildRegistry({ fundamental });

    const { stats } = await registry.execute('fundamental', backfillInput);

    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
    // 走区间模式 (getFundamentalsRange), 非批量 latest。
    expect(fundamental.latestCallCount).toBe(0);
    expect(fundamental.rangeCalls).toHaveLength(1);
    const q = fundamental.rangeCalls[0];
    expect(q.symbol).toBe('hk:00700');
    expect(Boolean(q.from && q.to && q.from < q.to)).toBe(true); // 区间 from<to

    // (instrumentId,date) 多行日频历史 (3 行, 非单快照)。
    const snaps = await prisma.fundamentalSnapshot.findMany({
      where: { instrumentId: instId },
      orderBy: { date: 'asc' },
    });
    expect(snaps).toHaveLength(3);
    expect(snaps.map((s) => s.date.toISOString().slice(0, 10))).toEqual([
      '2016-05-13',
      '2020-06-15',
      '2026-05-15',
    ]);
    expect(snaps[0].peTtm?.toString()).toBe('20.5');
    expect(snaps[0].pePctlY3?.toString()).toBe('0.42'); // 分位字段照落
    const run = await prisma.syncRun.findFirstOrThrow({ where: { syncType: 'sync:fundamental' } });
    expect(run.status).toBe('success');
  });

  // ── ② financial hk 多期 ──────────────────────────────────────────────────────
  it('② financial hk backfill → financial_metric (instrumentId,reportPeriod) 多期 (经 T013 区间模式)', async () => {
    const instId = await seedHk('00700', '腾讯控股');
    const financials = new HkFinancialsMock(new Set(['hk:00700']));
    const registry = buildRegistry({ financials });

    const { stats } = await registry.execute('financial', backfillInput);

    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
    expect(financials.latestCallCount).toBe(0);
    expect(financials.rangeCalls).toHaveLength(1);

    const metrics = await prisma.financialMetric.findMany({
      where: { instrumentId: instId },
      orderBy: { reportPeriod: 'asc' },
    });
    expect(metrics.map((m) => m.reportPeriod)).toEqual(['2024Q4', '2025Q2', '2025Q4']);
    expect(metrics[0].roe?.toString()).toBe('0.2'); // 0.20 → Decimal 归一 0.2
    expect(metrics.every((m) => m.grossMargin === null)).toBe(true); // 金融口径缺 gp_m → null
    const run = await prisma.syncRun.findFirstOrThrow({ where: { syncType: 'sync:financial' } });
    expect(run.status).toBe('success');
  });

  // ── ③ vendor 字段缺失存 null 不崩 (P2 分位字段) ───────────────────────────────
  it('③ vendor 分位字段缺失 (P2) → fundamental_snapshot 存 null 不崩 (沿 015 契约)', async () => {
    const instId = await seedHk('00823', '领展房产基金');
    const fundamental = new HkFundamentalMock(new Set(['hk:00823']), { dropPctl: true });
    const registry = buildRegistry({ fundamental });

    const { stats } = await registry.execute('fundamental', backfillInput);

    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 }); // 不计 failed
    const snaps = await prisma.fundamentalSnapshot.findMany({ where: { instrumentId: instId } });
    expect(snaps).toHaveLength(3);
    // 分位字段全 null (vendor 未下发), 但 peTtm 等有值仍落库。
    expect(snaps.every((s) => s.pePctlY3 === null && s.pePctlY5 === null)).toBe(true);
    expect(snaps.every((s) => s.pbPctlY3 === null && s.pbPctlY5 === null)).toBe(true);
    expect(snaps.every((s) => s.peTtm !== null)).toBe(true);
  });

  // ── ④ 幂等: backfill 连跑两次 → upsert 不翻倍 (自然键) ─────────────────────────
  it('④ 幂等: fundamental/financial backfill 连跑两次 → upsert on 自然键不翻倍', async () => {
    const instId = await seedHk('00700', '腾讯控股');
    const fundamental = new HkFundamentalMock(new Set(['hk:00700']));
    const financials = new HkFinancialsMock(new Set(['hk:00700']));
    const registry = buildRegistry({ fundamental, financials });

    await registry.execute('fundamental', backfillInput);
    await registry.execute('fundamental', backfillInput);
    await registry.execute('financial', backfillInput);
    await registry.execute('financial', backfillInput);

    expect(await prisma.fundamentalSnapshot.count({ where: { instrumentId: instId } })).toBe(3);
    expect(await prisma.financialMetric.count({ where: { instrumentId: instId } })).toBe(3);
  });
});
