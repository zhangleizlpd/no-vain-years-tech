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
    // 补洞道判据吃 trading_day ⇒ 必须逐例复位, 否则 ④⑤ 埋的日历会串进 ⑥ (它要的正是「日历为空」)。
    await prisma.tradingDay.deleteMany();
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

  // ── 补洞道 (fillRecentEodGaps): 捡回「当晚 vendor 还没出数」那批 ──────────────────────
  //
  // 病灶: syncEodBarNone 拿到空数组时 return + 计 ok ⇒ 那天过去后再没有任何请求会问起它,
  // 缺口永久且静默 (2026-08-12 prod: hk 每交易日少约 18%, 而三层信号一致报绿)。
  // 主跑窗口是精确当日, 故必须有一条旁路回头看最近几天 —— 且**不能**靠给 eod_bar 配
  // deltaLookbackDays 来做, 那会关掉 pendingEodInstruments 这个预算续跑进度锚 (即上面 ①②)。

  /** 窗内 cn 交易日 (= TARGET−7 内 3 天) ⇒ 「窗内补齐」判据 = 该标的有 3 行。 */
  async function seedCnCalendar(): Promise<void> {
    await prisma.tradingDay.createMany({
      data: ['2026-05-28', '2026-06-02', TARGET].map((d) => ({
        market: 'cn',
        date: new Date(`${d}T00:00:00Z`),
      })),
      skipDuplicates: true,
    });
  }

  /** 给某标的在指定日期埋 none bar (数值仅占位)。 */
  async function seedBars(instrumentId: bigint, dates: string[]): Promise<void> {
    await prisma.dailyBar.createMany({
      data: dates.map((d) => ({
        instrumentId,
        tradeDate: new Date(`${d}T00:00:00Z`),
        adjust: 'none',
        open: '1',
        high: '1',
        low: '1',
        close: '1',
      })),
      skipDuplicates: true,
    });
  }

  /** 记录 query 的 eod 端口 (主跑 from===to; 补洞道 from<to ⇒ 靠这点区分两类调用)。 */
  function recordingEod(calls: EodBarQuery[]): EodBarPort {
    const inner = eodAt(TARGET);
    return {
      getBars: async (q: EodBarQuery): Promise<EodBarPoint[]> => {
        calls.push({ ...q });
        return inner.getBars(q);
      },
    };
  }

  it('④ 补洞道: 窗内仍缺交易日的标的被补发一次区间请求, 已补齐的不重问', async () => {
    await seedCnCalendar();
    const insts = await prisma.instrument.findMany({ orderBy: { id: 'asc' } });
    // 前 4 只窗内已有 2 天 → 主跑补上 TARGET 那天即满 3 天; 第 5 只只有 1 天 → 主跑后仍差 1 天。
    for (const [i, inst] of insts.entries()) {
      await seedBars(inst.id, i < 4 ? ['2026-05-28', '2026-06-02'] : ['2026-05-28']);
    }

    const calls: EodBarQuery[] = [];
    await runEod(recordingEod(calls), 100);

    // 主跑 5 次 (精确当日, from===to) + 补洞 1 次 (区间, from<to)。
    const ranged = calls.filter((c) => c.from !== c.to);
    expect(ranged).toHaveLength(1);
    expect(ranged[0]?.symbol).toBe(`cn:${insts[4]?.code}`);
    expect(ranged[0]?.from).toBe('2026-05-27'); // TARGET − EOD_GAP_FILL_LOOKBACK_DAYS
  });

  it('⑤ 补洞道: 预算耗尽时不跑 —— 额度该留给顺延续跑, 不拿去补历史', async () => {
    await seedCnCalendar();
    const insts = await prisma.instrument.findMany({ orderBy: { id: 'asc' } });
    for (const inst of insts) await seedBars(inst.id, ['2026-05-28']); // 全员都缺 2 天

    const calls: EodBarQuery[] = [];
    const { budgetExhausted } = await runEod(recordingEod(calls), 2); // 预算 2 < 5 只

    expect(budgetExhausted).toBe(true);
    expect(calls.filter((c) => c.from !== c.to)).toHaveLength(0);
  });

  it('🚨 ⑥ 日历为空 → 补洞道缩手, 一个请求都不发 (拿可能已坏的表当判据时宁可少补)', async () => {
    // 不 seed trading_day (= 日历未填充 / 已陈旧的形态)。全员窗内只有 1 天, 若判据失灵会
    // 对全工作集狂发区间请求 —— 那比不补更糟。
    const insts = await prisma.instrument.findMany({ orderBy: { id: 'asc' } });
    for (const inst of insts) await seedBars(inst.id, ['2026-05-28']);

    const calls: EodBarQuery[] = [];
    await runEod(recordingEod(calls), 100);

    expect(calls.filter((c) => c.from !== c.to)).toHaveLength(0);
  });
});
