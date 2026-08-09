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
import type { CorporateActionPort } from '../../src/marketdata/corporate-action.port';
import type { EodBarPort } from '../../src/marketdata/eod-bar.port';
import type {
  CorporateActionDto,
  EodBarPoint,
  EodBarQuery,
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
  backfillHistoryDays: 3650,
};
const deltaInput = { mode: 'delta' as const, asOf: AS_OF, now: NOW };

// 038 T016 US2「港股基本面/财报/公司行动」聚合集成 IT (Testcontainers PG, test-local mock hk):
// 证 fundamental (区间多行日频) + financial (多期) + corporate_action (事件 + factor 重锚) 三维
// 在**同一批 hk 标的 (含 REIT)** 经同一 DimensionExecutorRegistry **端到端组合贯通** —— 单维分支
// 已由 T013 单测 / T014 (fundamental-financial) / T015 (corp-action-readjust) 各自内联 IT 覆盖,
// 本聚合侧重: (a) 多标的含房托 REIT 的组合, (b) 三维在同一标的共存的全维终态。
// 用 test-local mock hk adapter (非扩共享 MockMarketDataAdapter, 护 T006 seam IT); 落库经真 PG。
// 覆盖 state_branch: fundamental/fs hk 区间回填 / corporate_action hk 触发复权 / vendor 字段缺失存 null。
describe('038 T016 US2 港股基本面/财报/公司行动聚合 (Testcontainers PG, mock hk)', () => {
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
    await prisma.adjustmentFactor.deleteMany();
    await prisma.corporateAction.deleteMany();
    await prisma.dailyBar.deleteMany();
    await prisma.fundamentalSnapshot.deleteMany();
    await prisma.financialMetric.deleteMany();
    await prisma.instrument.deleteMany();
    await prisma.syncRun.deleteMany();
    await prisma.syncDimension.updateMany({
      where: { dimensionKey: { in: ['fundamental', 'financial', 'corporate_action'] } },
      data: { marketScope: ['cn', 'hk'] },
    });
  });

  // ── test-local mock hk adapters (3 维) ───────────────────────────────────────
  class HkFundamentalMock implements FundamentalPort {
    constructor(
      private readonly served: ReadonlySet<string>,
      private readonly dropPctlFor: ReadonlySet<string> = new Set(),
    ) {}
    async getFundamentals(): Promise<FundamentalSnapshotDto[]> {
      return []; // backfill 不走批量 latest
    }
    async getFundamentalsRange(query: FundamentalRangeQuery): Promise<FundamentalSnapshotDto[]> {
      if (!this.served.has(query.symbol)) return [];
      const dropPctl = this.dropPctlFor.has(query.symbol);
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
        pePctlY3: dropPctl ? null : '0.42',
        pePctlY5: dropPctl ? null : '0.38',
        pbPctlY3: dropPctl ? null : '0.55',
        pbPctlY5: dropPctl ? null : '0.51',
      }));
    }
  }

  class HkFinancialsMock implements FinancialsPort {
    constructor(private readonly served: ReadonlySet<string>) {}
    async getFinancials(): Promise<FinancialMetricDto[]> {
      return [];
    }
    async getFinancialsRange(query: FinancialsRangeQuery): Promise<FinancialMetricDto[]> {
      if (!this.served.has(query.symbol)) return [];
      return ['2024Q4', '2025Q2', '2025Q4'].map((reportPeriod, i) => ({
        symbol: query.symbol,
        reportPeriod,
        roe: `0.2${i}`,
        grossMargin: null,
        eps: '1.5',
        bps: '10',
      }));
    }
  }

  class HkCorpActionMock implements CorporateActionPort {
    constructor(private readonly bySymbol: Map<string, CorporateActionDto[]>) {}
    async getCorporateActions(symbol: string): Promise<CorporateActionDto[]> {
      return this.bySymbol.get(symbol) ?? [];
    }
  }

  class HkBackwardEodMock implements EodBarPort {
    constructor(private readonly bySymbol: Map<string, EodBarPoint[]>) {}
    async getBars(query: EodBarQuery): Promise<EodBarPoint[]> {
      return this.bySymbol.get(query.symbol) ?? [];
    }
  }

  function backwardBar(tradeDate: string, close: string): EodBarPoint {
    return {
      tradeDate,
      adjust: 'backward',
      open: close,
      high: close,
      low: close,
      close,
      changePct: null,
      prevClose: null,
      volume: null,
      amount: null,
      turnoverRate: null,
    };
  }

  function buildRegistry(opts: {
    fundamental?: FundamentalPort;
    financials?: FinancialsPort;
    corporateAction?: CorporateActionPort;
    eodBar?: EodBarPort;
  }): DimensionExecutorRegistry {
    const mock = new MockMarketDataAdapter();
    return new DimensionExecutorRegistry(
      new SyncUniverseUseCase(mock, prisma),
      new SyncProfileUseCase(mock, prisma),
      opts.eodBar ?? mock,
      opts.fundamental ?? mock,
      opts.financials ?? mock,
      opts.corporateAction ?? mock,
      prisma,
      new SyncRunRecorder(prisma),
      new SyncTierRecalc(prisma),
    );
  }

  /** 建 2 只在市 hk 标的: 00700 常规 (non) + 00823 房托 (reit)。 */
  async function seedHkUniverse(): Promise<{ tencent: bigint; link: bigint }> {
    const tencent = await prisma.instrument.create({
      data: {
        market: 'hk',
        code: '00700',
        name: '腾讯控股',
        type: 'stock',
        currency: 'HKD',
        status: 'active',
        lixingerCompanyType: 'non',
      },
    });
    const link = await prisma.instrument.create({
      data: {
        market: 'hk',
        code: '00823',
        name: '领展房产基金',
        type: 'stock',
        currency: 'HKD',
        status: 'active',
        lixingerCompanyType: 'reit',
      },
    });
    return { tencent: tencent.id, link: link.id };
  }

  const HK_SET = new Set(['hk:00700', 'hk:00823']);

  // ── ① fundamental hk 区间回填 (多行日频, 多标的含 REIT) ──────────────────────────
  it('① fundamental hk backfill → 2 标的 (含 reit) 各 fundamental_snapshot (instrumentId,date) 多行日频', async () => {
    const { tencent, link } = await seedHkUniverse();
    const registry = buildRegistry({ fundamental: new HkFundamentalMock(HK_SET) });

    const { stats } = await registry.execute('fundamental', backfillInput);

    expect(stats).toMatchObject({ scanned: 2, ok: 2, failed: 0 });
    for (const id of [tencent, link]) {
      const snaps = await prisma.fundamentalSnapshot.findMany({
        where: { instrumentId: id },
        orderBy: { date: 'asc' },
      });
      expect(snaps).toHaveLength(3); // 多行日频 (非单快照)
      expect(snaps.map((s) => s.date.toISOString().slice(0, 10))).toEqual([
        '2016-05-13',
        '2020-06-15',
        '2026-05-15',
      ]);
    }
  });

  // ── ② financial hk 多期 (多标的含 REIT) ──────────────────────────────────────
  it('② financial hk backfill → 2 标的各 financial_metric (instrumentId,reportPeriod) 多期', async () => {
    const { tencent, link } = await seedHkUniverse();
    const registry = buildRegistry({ financials: new HkFinancialsMock(HK_SET) });

    const { stats } = await registry.execute('financial', backfillInput);

    expect(stats).toMatchObject({ scanned: 2, ok: 2, failed: 0 });
    for (const id of [tencent, link]) {
      const metrics = await prisma.financialMetric.findMany({
        where: { instrumentId: id },
        orderBy: { reportPeriod: 'asc' },
      });
      expect(metrics.map((m) => m.reportPeriod)).toEqual(['2024Q4', '2025Q2', '2025Q4']);
    }
  });

  // ── ③ corporate_action hk 触发 factor 重锚 ────────────────────────────────────
  it('③ corporate_action hk → 有分红标的触发 factor 重锚, 无事件标的零 factor', async () => {
    const { tencent, link } = await seedHkUniverse();
    // 00700 除权前后 none 日线 (含跳空); 00823 无事件。
    await prisma.dailyBar.createMany({
      data: [
        {
          instrumentId: tencent,
          tradeDate: new Date('2026-05-14T00:00:00Z'),
          adjust: 'none',
          open: '100',
          high: '100',
          low: '100',
          close: '100',
          changePct: null,
          prevClose: null,
          volume: null,
          amount: null,
          turnoverRate: null,
        },
        {
          instrumentId: tencent,
          tradeDate: new Date('2026-05-15T00:00:00Z'),
          adjust: 'none',
          open: '98',
          high: '98',
          low: '98',
          close: '98',
          changePct: null,
          prevClose: null,
          volume: null,
          amount: null,
          turnoverRate: null,
        },
      ],
    });
    const corp = new HkCorpActionMock(
      new Map([
        [
          'hk:00700',
          [
            {
              symbol: 'hk:00700',
              exDate: '2026-05-15',
              type: 'dividend',
              payload: { dividend: 2, currency: 'HKD' },
            },
          ],
        ],
        // hk:00823 无事件
      ]),
    );
    const eod = new HkBackwardEodMock(
      new Map([['hk:00700', [backwardBar('2026-05-14', '100'), backwardBar('2026-05-15', '100')]]]),
    );
    const registry = buildRegistry({ corporateAction: corp, eodBar: eod });

    const { stats } = await registry.execute('corporate_action', deltaInput);

    expect(stats).toMatchObject({ scanned: 2, ok: 2, failed: 0 });
    // 00700: corp-action 落库 + factor 重锚。
    expect(await prisma.corporateAction.count({ where: { instrumentId: tencent } })).toBe(1);
    const factors = await prisma.adjustmentFactor.findMany({ where: { instrumentId: tencent } });
    expect(factors).toHaveLength(1);
    expect(Number(factors[0].factorBackward)).toBeCloseTo(100 / 98, 4);
    // 00823: 无事件 → 零 corp-action / 零 factor。
    expect(await prisma.corporateAction.count({ where: { instrumentId: link } })).toBe(0);
    expect(await prisma.adjustmentFactor.count({ where: { instrumentId: link } })).toBe(0);
  });

  // ── ④ vendor 字段缺失存 null 不崩 (REIT 分位字段, 组合上下文) ────────────────────
  it('④ vendor 分位字段缺失 → REIT 标的 fundamental_snapshot 存 null 不崩, run success (P2)', async () => {
    const { tencent, link } = await seedHkUniverse();
    // 00823 (reit) vendor 不下发分位; 00700 下发。
    const fundamental = new HkFundamentalMock(HK_SET, new Set(['hk:00823']));
    const registry = buildRegistry({ fundamental });

    const { stats } = await registry.execute('fundamental', backfillInput);

    expect(stats.failed).toBe(0); // 缺字段不计 failed
    const reitSnaps = await prisma.fundamentalSnapshot.findMany({ where: { instrumentId: link } });
    expect(reitSnaps).toHaveLength(3);
    expect(reitSnaps.every((s) => s.pePctlY3 === null && s.pbPctlY5 === null)).toBe(true); // 分位 null
    expect(reitSnaps.every((s) => s.peTtm !== null)).toBe(true); // 非分位字段仍落库
    // 常规标的 00700 分位照落 (混批不互相污染)。
    const nonSnaps = await prisma.fundamentalSnapshot.findMany({
      where: { instrumentId: tencent },
    });
    expect(nonSnaps.every((s) => s.pePctlY3 !== null)).toBe(true);
    const run = await prisma.syncRun.findFirstOrThrow({ where: { syncType: 'sync:fundamental' } });
    expect(run.status).toBe('success');
  });

  // ── ⑤ US2 全维贯通 (组合): 三维在同一批 hk 标的经同一 registry 顺序跑 → 全维终态一致 ──
  it('⑤ US2 全维贯通: fundamental+financial+corporate_action 同批 hk 标的顺序跑 → 全维终态', async () => {
    const { tencent, link } = await seedHkUniverse();
    await prisma.dailyBar.createMany({
      data: [
        {
          instrumentId: tencent,
          tradeDate: new Date('2026-05-14T00:00:00Z'),
          adjust: 'none',
          open: '100',
          high: '100',
          low: '100',
          close: '100',
          changePct: null,
          prevClose: null,
          volume: null,
          amount: null,
          turnoverRate: null,
        },
        {
          instrumentId: tencent,
          tradeDate: new Date('2026-05-15T00:00:00Z'),
          adjust: 'none',
          open: '98',
          high: '98',
          low: '98',
          close: '98',
          changePct: null,
          prevClose: null,
          volume: null,
          amount: null,
          turnoverRate: null,
        },
      ],
    });
    const registry = buildRegistry({
      fundamental: new HkFundamentalMock(HK_SET, new Set(['hk:00823'])),
      financials: new HkFinancialsMock(HK_SET),
      corporateAction: new HkCorpActionMock(
        new Map([
          [
            'hk:00700',
            [
              {
                symbol: 'hk:00700',
                exDate: '2026-05-15',
                type: 'dividend',
                payload: { dividend: 2, currency: 'HKD' },
              },
            ],
          ],
        ]),
      ),
      eodBar: new HkBackwardEodMock(
        new Map([
          ['hk:00700', [backwardBar('2026-05-14', '100'), backwardBar('2026-05-15', '100')]],
        ]),
      ),
    });

    // 三维顺序跑 (同一 registry, 同批标的)。
    await registry.execute('fundamental', backfillInput);
    await registry.execute('financial', backfillInput);
    await registry.execute('corporate_action', deltaInput);

    // 全维终态: 两只 hk 标的均有 fundamental 历史 + financial 多期; 仅 00700 有 corp-action + factor。
    for (const id of [tencent, link]) {
      expect(await prisma.fundamentalSnapshot.count({ where: { instrumentId: id } })).toBe(3);
      expect(await prisma.financialMetric.count({ where: { instrumentId: id } })).toBe(3);
    }
    expect(await prisma.corporateAction.count({ where: { instrumentId: tencent } })).toBe(1);
    expect(await prisma.adjustmentFactor.count({ where: { instrumentId: tencent } })).toBe(1);
    expect(await prisma.corporateAction.count({ where: { instrumentId: link } })).toBe(0);

    // 三维 SyncRun 全 success (per-dim 审计行如实)。
    for (const syncType of ['sync:fundamental', 'sync:financial', 'sync:corporate_action']) {
      const run = await prisma.syncRun.findFirstOrThrow({ where: { syncType } });
      expect(run.status).toBe('success');
    }
  });
});
