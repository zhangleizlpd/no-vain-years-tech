import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import { MockMarketDataAdapter } from '../../src/marketdata/mock-market-data.adapter';
import { SyncRunRecorder } from '../../src/marketdata/sync-run.recorder';
import { SyncTierRecalc } from '../../src/marketdata/sync-tier-recalc';
import { SyncUniverseUseCase } from '../../src/marketdata/sync-universe.usecase';
import { SyncProfileUseCase } from '../../src/marketdata/sync-profile.usecase';
import { DimensionExecutorRegistry } from '../../src/marketdata/dimension-executor';
import type { EodBarPort } from '../../src/marketdata/eod-bar.port';
import type { EodBarPoint, EodBarQuery } from '../../src/marketdata/marketdata.types';

const TRADING_DAY = new Date('2026-06-03T12:00:00Z'); // 周三
const TARGET = '2026-06-03';

/** 任一 symbol 在目标日返一根 bar 的 eod adapter (供 budget/resume 控量)。 */
function eodAt(date: string): EodBarPort {
  return {
    getBars: async (q: EodBarQuery): Promise<EodBarPoint[]> => [
      {
        tradeDate: date,
        adjust: q.adjust,
        open: '1',
        high: '1',
        low: '1',
        close: '1',
        changePct: null,
        prevClose: null,
        volume: null,
        amount: null,
        turnoverRate: null,
      },
    ],
  };
}

// 016 T012 → 017 PR-7 改造: eod_bar executor 直调 (Testcontainers PG): 全标的统一序消费;
// maxEodInstruments 预算耗尽 → 剩余顺延(水位)+ 已同步标的下窗不重拉。
describe('016 T012 EOD uniform sync + quota carry-over (watermark resume)', () => {
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
    await prisma.dailyBar.deleteMany();
    await prisma.instrument.deleteMany();
    await prisma.syncRun.deleteMany();
    // executor 直调天然单维度隔离; 只复位水位。
    await prisma.syncDimension.update({
      where: { dimensionKey: 'eod_bar' },
      data: { lastWatermark: null },
    });
    // 5 个活跃标的 (id 升序 = 消费序), syncTier 默认 2。
    for (let i = 1; i <= 5; i++) {
      await prisma.instrument.create({
        data: {
          market: 'cn',
          code: `00000${i}`,
          name: `t${i}`,
          type: 'stock',
          currency: 'CNY',
          status: 'active',
        },
      });
    }
  });

  function buildRegistry(eodBar: EodBarPort): DimensionExecutorRegistry {
    const mock = new MockMarketDataAdapter();
    return new DimensionExecutorRegistry(
      new SyncUniverseUseCase(mock, prisma),
      new SyncProfileUseCase(mock, prisma),
      eodBar,
      mock,
      mock,
      mock,
      prisma,
      new SyncRunRecorder(prisma),
      new SyncTierRecalc(prisma),
    );
  }

  /** eod_bar executor 直调 (delta, 控时 TRADING_DAY)。 */
  async function runEod(eodBar: EodBarPort, maxEodInstruments: number) {
    return buildRegistry(eodBar).execute('eod_bar', {
      mode: 'delta',
      asOf: TARGET,
      now: TRADING_DAY,
      maxEodInstruments,
    });
  }

  it('① 预算耗尽 → 仅预算内标的落库, 剩余计 skipped + 水位推进', async () => {
    const { stats } = await runEod(eodAt(TARGET), 2);

    // 2 标的 × none 1 行 (020 T008 单口径); 3 标的顺延。
    expect(await prisma.dailyBar.count()).toBe(2);
    const doneInstrumentIds = await prisma.dailyBar.findMany({
      where: { tradeDate: new Date(`${TARGET}T00:00:00Z`) },
      select: { instrumentId: true },
      distinct: ['instrumentId'],
    });
    expect(doneInstrumentIds).toHaveLength(2);
    expect(stats.skipped).toBe(3); // 顺延标的
    const dim = await prisma.syncDimension.findUniqueOrThrow({
      where: { dimensionKey: 'eod_bar' },
    });
    expect(dim.lastWatermark).not.toBeNull(); // 水位记进度

    // syncTier 维持默认 2 (US4: 不重算)。
    const tiers = await prisma.instrument.findMany({ select: { syncTier: true } });
    expect(tiers.every((t) => t.syncTier === 2)).toBe(true);
  });

  it('② 下窗续跑: 已同步标的不重拉, 仅剩余被处理, 无重复行', async () => {
    const eod = eodAt(TARGET);
    const getBarsSpy = vi.spyOn(eod, 'getBars');

    await runEod(eod, 2); // 窗1: 标的 1,2
    const firstWindowSymbols = new Set(getBarsSpy.mock.calls.map((c) => c[0].symbol));
    getBarsSpy.mockClear();

    await runEod(eod, 2); // 窗2: 标的 3,4
    const secondWindowSymbols = new Set(getBarsSpy.mock.calls.map((c) => c[0].symbol));

    // 窗2 不重拉窗1 已落库标的 (已同步不重复)。
    for (const s of firstWindowSymbols) expect(secondWindowSymbols.has(s)).toBe(false);
    // 累计 4 标的落库, none 各 1 行, 无重复。
    const done = await prisma.dailyBar.findMany({
      where: { tradeDate: new Date(`${TARGET}T00:00:00Z`) },
      select: { instrumentId: true },
      distinct: ['instrumentId'],
    });
    expect(done).toHaveLength(4);
    expect(await prisma.dailyBar.count()).toBe(4); // 4 × 1, 非翻倍
  });

  it('③ 预算充足 → 全标的一窗跑完, 无 skipped 顺延', async () => {
    const { stats, budgetExhausted } = await runEod(eodAt(TARGET), 100);

    expect(budgetExhausted).toBe(false);
    expect(stats.skipped).toBe(0);
    expect(await prisma.dailyBar.count()).toBe(5); // 5 × 1
  });
});
