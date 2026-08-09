import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import { MockMarketDataAdapter } from '../../src/marketdata/mock-market-data.adapter';
import { SyncRunRecorder } from '../../src/marketdata/sync-run.recorder';
import { SyncTierRecalc } from '../../src/marketdata/sync-tier-recalc';
import { SyncUniverseUseCase } from '../../src/marketdata/sync-universe.usecase';
import { SyncProfileUseCase } from '../../src/marketdata/sync-profile.usecase';
import { DimensionExecutorRegistry } from '../../src/marketdata/dimension-executor';
import { VOLATILITY_WINDOWS } from '../../src/marketdata/lixinger-volatility.adapter';
import type { VolatilityPort } from '../../src/marketdata/volatility.port';
import type { VolatilityPoint, VolatilityRangeQuery } from '../../src/marketdata/marketdata.types';

const NOW = new Date('2026-06-03T12:00:00Z');
const AS_OF = '2026-06-03';
const backfillInput = {
  mode: 'backfill' as const,
  asOf: AS_OF,
  now: NOW,
  backfillHistoryDays: 3650, // ≤10yr 区间
};

// 040 T006 US1 波动率日频集成 IT (Testcontainers PG, test-local mock hk 埋 rangeCalls):
// volatility hk backfill 经 executor 区间模式 × VOLATILITY_WINDOWS 多窗口循环落
// (instrumentId, date, volatilityDays) 多行日频 + 连跑幂等 (createMany skipDuplicates 自然键) +
// 3 窗口每窗口成行 (同 date 3 行) + per-stock 单 symbol + volatilityDays number 单数 (executor 层「param
// 契约三分」volatility 侧) + from=asOf−historyDepth (10yr, seed-driven)。用 test-local mock hk adapter
// (非扩共享 MockMarketDataAdapter, 后者 hk=no-data 护 seam); 落库经真 PG。覆盖 state_branch: 波动率日频
// 回填 / 波动率多窗口 / 波动率历史深度 / param 契约三分 (volatility executor) / 2 维度 marketScope 纳入。
describe('040 T006 volatility 日频 × 多窗口 (Testcontainers PG, mock hk)', () => {
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
    await prisma.volatilityDaily.deleteMany();
    await prisma.instrument.deleteMany();
    await prisma.syncRun.deleteMany();
    // T002 (040 Phase 1) migration seed 已把 volatility marketScope={hk} + historyDepth=3650;
    // 显式复位保各例独立 (不篡改 seed 语义, 只固定测试起点)。
    await prisma.syncDimension.updateMany({
      where: { dimensionKey: 'volatility' },
      data: { marketScope: ['hk'], historyDepth: 3650 },
    });
  });

  /**
   * test-local hk volatility adapter: 记 rangeCalls (验请求走区间 + per-stock 单 symbol +
   * volatilityDays number 单数)。served 集内标的对**每个窗口**返 3 行跨年日频 (value 掺入窗口以便
   * 区分窗口来源), 集外 → [] (无数据标的)。
   */
  class HkVolatilityMock implements VolatilityPort {
    readonly rangeCalls: VolatilityRangeQuery[] = [];
    constructor(private readonly served: ReadonlySet<string>) {}
    async getVolatilityRange(query: VolatilityRangeQuery): Promise<VolatilityPoint[]> {
      this.rangeCalls.push(query);
      if (!this.served.has(query.symbol)) return [];
      // 各窗口同 date 集 → 同 (instrumentId,date) 每窗口一行 (窗口数=行倍数); value 编入窗口区分。
      return ['2016-06-15', '2020-06-15', '2026-05-15'].map((date, i) => ({
        date,
        value: `0.${query.volatilityDays}${i}`,
      }));
    }
  }

  function buildRegistry(opts: { volatility?: VolatilityPort }): DimensionExecutorRegistry {
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
      opts.volatility ?? mock, // volatility (尾部)
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

  // ── ① volatility hk 区间回填: 多年日频落库 + 请求走区间 + per-stock 单 symbol + volatilityDays number ──
  it('① volatility hk backfill → volatility_daily 多年日频落库 + 请求走区间 (单数 stockCode + volatilityDays number)', async () => {
    const instId = await seedHk('00700', '腾讯控股');
    const volatility = new HkVolatilityMock(new Set(['hk:00700']));
    const registry = buildRegistry({ volatility });

    const { stats } = await registry.execute('volatility', backfillInput);

    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
    // 多窗口: VOLATILITY_WINDOWS 每窗口一次请求 = N 次 (单股)。
    expect(volatility.rangeCalls).toHaveLength(VOLATILITY_WINDOWS.length);
    for (const q of volatility.rangeCalls) {
      // param 契约三分 (volatility 侧, executor): per-stock 单 symbol + volatilityDays number 单数 + 走区间。
      expect(q.symbol).toBe('hk:00700');
      expect(typeof q.volatilityDays).toBe('number');
      expect(Array.isArray(q.volatilityDays)).toBe(false);
      expect(Boolean(q.from && q.to && q.from < q.to)).toBe(true);
    }
    // 每窗口独立 volatilityDays, 覆盖全窗口集。
    expect(volatility.rangeCalls.map((q) => q.volatilityDays).sort((a, b) => a - b)).toEqual(
      [...VOLATILITY_WINDOWS].sort((a, b) => a - b),
    );

    // 落库: 3 date × N 窗口 = 3N 行 (单股)。
    const rows = await prisma.volatilityDaily.findMany({
      where: { instrumentId: instId },
      orderBy: [{ date: 'asc' }, { volatilityDays: 'asc' }],
    });
    expect(rows).toHaveLength(3 * VOLATILITY_WINDOWS.length);
    const run = await prisma.syncRun.findFirstOrThrow({ where: { syncType: 'sync:volatility' } });
    expect(run.status).toBe('success');
  });

  // ── ② 多窗口成行: 同一 (instrumentId,date) 出 N 行 (每窗口一行, volatilityDays 各异) ──
  it('② 波动率多窗口 → 同一 (instrumentId,date) 出 N 行 (每窗口一行)', async () => {
    const instId = await seedHk('00700', '腾讯控股');
    const volatility = new HkVolatilityMock(new Set(['hk:00700']));
    const registry = buildRegistry({ volatility });

    await registry.execute('volatility', backfillInput);

    // 同一 date '2020-06-15' → 每窗口一行 = N 行, volatilityDays 覆盖全窗口集。
    const sameDate = await prisma.volatilityDaily.findMany({
      where: { instrumentId: instId, date: new Date('2020-06-15T00:00:00Z') },
      orderBy: { volatilityDays: 'asc' },
    });
    expect(sameDate).toHaveLength(VOLATILITY_WINDOWS.length);
    expect(sameDate.map((r) => r.volatilityDays).sort((a, b) => a - b)).toEqual(
      [...VOLATILITY_WINDOWS].sort((a, b) => a - b),
    );
    // value 落库正确 (窗口编入 value 区分, 30 窗口 date-index 1 → '0.301')。
    const w30 = sameDate.find((r) => r.volatilityDays === 30);
    expect(w30?.value?.toString()).toBe('0.301');
  });

  // ── ③ 波动率历史深度: from = asOf − historyDepth (seed=3650 ≈ 10yr), 不传 backfillHistoryDays ──
  it('③ 波动率历史深度 → from = asOf − seed historyDepth (3650, 10yr)', async () => {
    await seedHk('00700', '腾讯控股');
    const volatility = new HkVolatilityMock(new Set(['hk:00700']));
    const registry = buildRegistry({ volatility });

    // 不传 backfillHistoryDays → syncVolatility 落到 dim.historyDepth (seed=3650)。
    await registry.execute('volatility', { mode: 'backfill', asOf: AS_OF, now: NOW });

    expect(volatility.rangeCalls.length).toBeGreaterThan(0);
    const q = volatility.rangeCalls[0];
    const gapDays = (new Date(q.to as string).getTime() - new Date(q.from).getTime()) / 86_400_000;
    expect(Math.round(gapDays)).toBe(3650); // from = asOf − seed historyDepth
  });

  // ── ④ 幂等: backfill 连跑两次 → createMany skipDuplicates 不翻倍 (自然键 instrumentId,date,volatilityDays) ──
  it('④ 幂等: volatility backfill 连跑两次 → 自然键不翻倍', async () => {
    const instId = await seedHk('00700', '腾讯控股');
    const volatility = new HkVolatilityMock(new Set(['hk:00700']));
    const registry = buildRegistry({ volatility });

    await registry.execute('volatility', backfillInput);
    await registry.execute('volatility', backfillInput);

    expect(await prisma.volatilityDaily.count({ where: { instrumentId: instId } })).toBe(
      3 * VOLATILITY_WINDOWS.length,
    );
  });

  // ── ⑤ 2 维度 marketScope 纳入 (volatility 侧): marketScope={hk} → hk 标的入工作集、cn 标的排除 ──
  it('⑤ marketScope={hk} → hk 标的入工作集处理, cn 标的排除 (2 维度 marketScope 纳入)', async () => {
    const hkId = await seedHk('00700', '腾讯控股');
    const cnInst = await prisma.instrument.create({
      data: {
        market: 'cn',
        code: '600519',
        name: '贵州茅台',
        type: 'stock',
        currency: 'CNY',
        status: 'active',
      },
    });
    const volatility = new HkVolatilityMock(new Set(['hk:00700']));
    const registry = buildRegistry({ volatility });

    const { stats } = await registry.execute('volatility', backfillInput);

    // 仅 hk 标的入工作集 (marketScope={hk}) → cn 从不被请求。
    expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0 });
    expect(volatility.rangeCalls.every((q) => q.symbol === 'hk:00700')).toBe(true);
    expect(await prisma.volatilityDaily.count({ where: { instrumentId: hkId } })).toBe(
      3 * VOLATILITY_WINDOWS.length,
    );
    expect(await prisma.volatilityDaily.count({ where: { instrumentId: cnInst.id } })).toBe(0);
  });
});
