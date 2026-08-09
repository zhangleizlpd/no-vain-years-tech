import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { QueueEvents } from 'bullmq';
import { PrismaService } from '../../src/security/prisma.service';
import { MockMarketDataAdapter } from '../../src/marketdata/mock-market-data.adapter';
import { SyncRunRecorder } from '../../src/marketdata/sync-run.recorder';
import { SyncTierRecalc } from '../../src/marketdata/sync-tier-recalc';
import { SyncUniverseUseCase } from '../../src/marketdata/sync-universe.usecase';
import { SyncProfileUseCase } from '../../src/marketdata/sync-profile.usecase';
import { DimensionExecutorRegistry } from '../../src/marketdata/dimension-executor';
import { BackfillPacer } from '../../src/marketdata/backfill-pacer';
import { VOLATILITY_WINDOWS } from '../../src/marketdata/lixinger-volatility.adapter';
import { HOT_TYPES } from '../../src/marketdata/lixinger-hot.adapter';
import { QueueRedisLifecycle } from '../../src/marketdata/marketdata-queue-connection';
import {
  MARKETDATA_SYNC_QUEUE,
  MarketdataSyncQueue,
  MarketdataSyncWorker,
} from '../../src/marketdata/marketdata-sync.worker';
import { executeBackfill, type BackfillDeps } from '../../src/marketdata/marketdata-backfill.cli';
import type { EodBarPort } from '../../src/marketdata/eod-bar.port';
import type { VolatilityPort } from '../../src/marketdata/volatility.port';
import type { HotSnapshotPort } from '../../src/marketdata/hot-snapshot.port';
import type { MarketdataSyncConfig } from '../../src/config/marketdata.config';
import type {
  EodBarPoint,
  EodBarQuery,
  HotSnapshotDto,
  HotSnapshotQuery,
  VolatilityPoint,
  VolatilityRangeQuery,
} from '../../src/marketdata/marketdata.types';

const NOW = new Date('2026-06-03T12:00:00Z'); // 周三 (Asia/Shanghai 交易日)
const AS_OF = '2026-06-03';
const backfillInput = {
  mode: 'backfill' as const,
  asOf: AS_OF,
  now: NOW,
  backfillHistoryDays: 3650,
};
// hot 无 mode 分支, 复用 delta input (mode 值不影响 hot 行为, pace 恒触发)。
const hotInput = { mode: 'delta' as const, asOf: AS_OF, now: NOW };

const CFG: MarketdataSyncConfig = {
  backfillDefaultHistoryDays: 365,
  requeueDelayMs: 1_800_000,
  cliWaitTimeoutMs: 14_400_000,
  removeOnCompleteCount: 200,
  removeOnFailCount: 500,
  tickEnabled: false,
  optionCoverageThreshold: 1,
};

/** 可控虚拟时钟: sleep 推进时间, 让回填自限速无需真等待即可断言 (镜像 038/039 pacing IT)。 */
function makeClock(start = 0) {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
    get t() {
      return t;
    },
  };
}

// 040 T011 US 回填 pacing + 续跑 + 无回归集成 IT (Testcontainers PG+Redis, test-local hk mock):
// 证 2 新维度回填温和安全 (volatility per-窗口自限速 + jitter 打散 / hot per-type 恒限速) +
// 中断按自然键幂等续跑 + p1(6 维)/p2(039 5 维)/A股零回归。直调 registry.execute 测 pacer 层
// (虚拟时钟, 无真等待); 经真 PG 落库/幂等/marketScope; 经真队列 (Redis worker concurrency=1) 测
// CLI 单维度 job 续跑。覆盖 spec state_branches: 回填自限速续跑 / p1/p2/A股无回归 /
// 2 维度 marketScope 纳入 (全工作集)。
describe('040 T011 US 回填 pacing + 续跑 + 无回归 (Testcontainers PG+Redis, mock hk)', () => {
  let prisma: PrismaService;
  let lifecycle: QueueRedisLifecycle;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.DATABASE_URL = stores.databaseUrl;
    prisma = new PrismaService(stores.databaseUrl);
    await prisma.$connect();
    lifecycle = new QueueRedisLifecycle(stores.redisUrl);
  }, 180_000);

  afterAll(async () => {
    lifecycle?.onApplicationShutdown();
    await prisma?.$disconnect();
    await stores.drop();
  });

  beforeEach(async () => {
    await prisma.dailyBar.deleteMany();
    await prisma.volatilityDaily.deleteMany();
    await prisma.hotSnapshot.deleteMany();
    await prisma.instrument.deleteMany();
    await prisma.syncRun.deleteMany();
    // 040 2 新维度回 marketScope={hk} (港股专属信号) + 各自 history_depth; p1 核心维度回 {cn,hk} + 清水位。
    await prisma.syncDimension.updateMany({
      where: { dimensionKey: 'volatility' },
      data: { marketScope: ['hk'], historyDepth: 3650 },
    });
    await prisma.syncDimension.updateMany({
      where: { dimensionKey: 'hot_snapshot' },
      data: { marketScope: ['hk'], historyDepth: null },
    });
    await prisma.syncDimension.updateMany({
      where: { dimensionKey: { in: ['eod_bar', 'fundamental', 'financial', 'corporate_action'] } },
      data: { marketScope: ['cn', 'hk'], lastWatermark: null },
    });
    const q = new MarketdataSyncQueue(lifecycle.client, CFG);
    await q.queue.obliterate({ force: true });
    await q.queue.close();
  });

  /** eod bar fixture 行 (仅结构占位, 照 039 pacing IT)。 */
  function bar(tradeDate: string, adjust: EodBarPoint['adjust']): EodBarPoint {
    return {
      tradeDate,
      adjust,
      open: '1',
      high: '1',
      low: '1',
      close: '1',
      changePct: null,
      prevClose: null,
      volume: null,
      amount: null,
      turnoverRate: null,
    };
  }

  /** test-local eod 端口: served 集内标的返区间多行 (含 to); 集外 → []。 */
  class ServedEodMock implements EodBarPort {
    constructor(private readonly served: ReadonlySet<string>) {}
    async getBars(query: EodBarQuery): Promise<EodBarPoint[]> {
      if (!this.served.has(query.symbol)) return [];
      const to = query.to ?? AS_OF;
      const from = query.from ?? to;
      const candidates = from === to ? [to] : ['2026-05-15', '2026-05-29', to];
      return candidates.filter((d) => d >= from && d <= to).map((d) => bar(d, query.adjust));
    }
  }

  /** test-local hk volatility 端口: 记 rangeCalls; served 返 3 行跨年日频/窗口, 集外 → []。 */
  class HkVolatilityMock implements VolatilityPort {
    readonly rangeCalls: VolatilityRangeQuery[] = [];
    constructor(private readonly served: ReadonlySet<string>) {}
    async getVolatilityRange(query: VolatilityRangeQuery): Promise<VolatilityPoint[]> {
      this.rangeCalls.push(query);
      if (!this.served.has(query.symbol)) return [];
      return ['2016-06-15', '2020-06-15', '2026-05-15'].map((date, i) => ({
        date,
        value: `0.${query.volatilityDays}${i}`,
      }));
    }
  }

  /** test-local hk hot 端口: 记 calls; served 返固定 dataDate 快照 (每 type 一行), 集外 → []。 */
  class HkHotMock implements HotSnapshotPort {
    readonly calls: HotSnapshotQuery[] = [];
    constructor(
      private readonly served: ReadonlySet<string>,
      private readonly dataDate = '2026-06-01',
    ) {}
    async getHotSnapshot(query: HotSnapshotQuery): Promise<HotSnapshotDto[]> {
      this.calls.push(query);
      if (!query.stockCodes.some((s) => this.served.has(s))) return [];
      return [{ hotType: query.hotType, dataDate: this.dataDate, payload: { stockCode: '00700' } }];
    }
  }

  function buildRegistry(
    overrides: {
      pacer?: BackfillPacer;
      eodBar?: EodBarPort;
      volatility?: VolatilityPort;
      hotSnapshot?: HotSnapshotPort;
    } = {},
  ): DimensionExecutorRegistry {
    const mock = new MockMarketDataAdapter();
    return new DimensionExecutorRegistry(
      new SyncUniverseUseCase(mock, prisma),
      new SyncProfileUseCase(mock, prisma),
      overrides.eodBar ?? mock,
      mock, // fundamental
      mock, // financials
      mock, // corporateAction
      prisma,
      new SyncRunRecorder(prisma),
      new SyncTierRecalc(prisma),
      overrides.pacer ?? BackfillPacer.disabled(),
      mock, // shortSelling
      mock, // connectHolding
      mock, // fundHolding
      mock, // fundCompanyHolding
      mock, // indexMembership
      overrides.volatility ?? mock, // volatility (arg 16)
      overrides.hotSnapshot ?? mock, // hotSnapshot (arg 17)
    );
  }

  function buildDeps(queue: MarketdataSyncQueue, events: QueueEvents): BackfillDeps {
    return {
      prisma,
      syncQueue: queue,
      queueEvents: events,
      cliWaitTimeoutMs: 60_000,
      backfillDefaultHistoryDays: 3650,
    };
  }

  /** seed 一只活跃标的 (currency 按 market)。 */
  async function seed(market: string, code: string): Promise<bigint> {
    const inst = await prisma.instrument.create({
      data: {
        market,
        code,
        name: `${market}-${code}`,
        type: 'stock',
        currency: market === 'hk' ? 'HKD' : 'CNY',
        status: 'active',
        lixingerCompanyType: 'non',
      },
    });
    return inst.id;
  }

  /** seed n 只 hk 标的, 返 canonical symbols。 */
  async function seedHk(n: number): Promise<string[]> {
    const symbols: string[] = [];
    for (let i = 1; i <= n; i++) {
      const code = `0000${i}`;
      await seed('hk', code);
      symbols.push(`hk:${code}`);
    }
    return symbols;
  }

  // ── ① volatility hk backfill per-窗口 自限速 (多窗口循环均 pace: sleeps = K×N−1) ──────────
  it('① volatility hk backfill per-窗口 pace → sleeps=K×窗口数−1, 有效 sustained ≤ 600/min', async () => {
    const K = 3;
    const served = new Set(await seedHk(K));
    const clock = makeClock(0);
    // enabled pacer 600/min (base=100ms), jitter=0 隔离基础节流, 注入虚拟时钟。
    const pacer = new BackfillPacer(
      { targetPerMin: 600, jitterMs: 0 },
      clock.now,
      clock.sleep,
      () => 0,
    );
    const reg = buildRegistry({ pacer, volatility: new HkVolatilityMock(served) });

    const { stats } = await reg.execute('volatility', backfillInput);

    // K 只 × N 窗口各 pace 一次: 首个免等 + 其余 (K×N−1) 各 sleep 100ms (base) → **多窗口循环均 pace** 得证
    // (3× 请求数须 3× 节流, plan Decision 4)。
    const paceCount = K * VOLATILITY_WINDOWS.length;
    expect(clock.sleeps.length, 'volatility 应 per-窗口 pace (K×窗口数−1)').toBe(paceCount - 1);
    expect(clock.t).toBeGreaterThanOrEqual((paceCount - 1) * 100);
    // 稳态速率 ≤ 目标 600/min = 不触 vendor 分钟级封禁 (429) 的机制保证。
    const sustainedPerMin = (paceCount - 1) / (clock.t / 60_000);
    expect(sustainedPerMin).toBeLessThanOrEqual(600 + 1e-6);
    expect(stats).toMatchObject({ scanned: K, failed: 0 });
  });

  // ── ② jitter 打散: volatility 每窗口节流间隔非等距 → 规避等间隔机器人特征 ────────────────
  it('② jitter 打散: volatility backfill 每窗口节流间隔非等距 (base + 随机 jitter)', async () => {
    const K = 2;
    const served = new Set(await seedHk(K));
    const clock = makeClock(0);
    const randSeq = [0, 0.5, 1.0];
    let ri = 0;
    const pacer = new BackfillPacer(
      { targetPerMin: 600, jitterMs: 40 },
      clock.now,
      clock.sleep,
      () => randSeq[ri++ % randSeq.length],
    );
    const reg = buildRegistry({ pacer, volatility: new HkVolatilityMock(served) });

    await reg.execute('volatility', backfillInput);

    // (K×窗口数−1) 次 sleep, 各 = base(100) + jitter(∈[0,40]); random 变化 → 至少两种不同间隔值 (打散)。
    expect(clock.sleeps.length).toBe(K * VOLATILITY_WINDOWS.length - 1);
    expect(new Set(clock.sleeps).size).toBeGreaterThan(1);
    // jitter 只增不减 → 每次间隔恒 ≥ base → 有效速率恒 ≤ 目标 (打散不破坏限速上界)。
    expect(Math.min(...clock.sleeps)).toBeGreaterThanOrEqual(100);
  });

  // ── ③ hot_snapshot per-type 恒限速 (无 mode 分支, 每次 vendor 调用前 pace: sleeps = K×type数−1) ──
  it('③ hot_snapshot per-type pace → sleeps=K×type数−1 (无 mode 恒限速)', async () => {
    const K = 2;
    const served = new Set(await seedHk(K));
    const clock = makeClock(0);
    const pacer = new BackfillPacer(
      { targetPerMin: 600, jitterMs: 0 },
      clock.now,
      clock.sleep,
      () => 0,
    );
    const reg = buildRegistry({ pacer, hotSnapshot: new HkHotMock(served) });

    const { stats } = await reg.execute('hot_snapshot', hotInput);

    const paceCount = K * HOT_TYPES.length;
    expect(clock.sleeps.length, 'hot 应 per-type pace (K×type数−1)').toBe(paceCount - 1);
    const sustainedPerMin = (paceCount - 1) / (clock.t / 60_000);
    expect(sustainedPerMin).toBeLessThanOrEqual(600 + 1e-6);
    expect(stats).toMatchObject({ scanned: paceCount, failed: 0 });
  });

  // ── ④ 中断后自然键幂等续跑: volatility(日频多窗口) + hot_snapshot(快照 upsert) 连跑不翻倍 ──
  it('④ 中断后自然键幂等续跑: volatility + hot_snapshot 连跑两次不翻倍', async () => {
    const instId = await seed('hk', '00700');
    const served = new Set(['hk:00700']);

    // volatility 自然键 (instrumentId,date,volatilityDays): 连跑两次 (中间清 syncRun 模拟中断续跑) → skipDuplicates 不翻倍。
    const volReg = buildRegistry({ volatility: new HkVolatilityMock(served) });
    await volReg.execute('volatility', backfillInput);
    const volAfter1 = await prisma.volatilityDaily.count({ where: { instrumentId: instId } });
    expect(volAfter1).toBe(3 * VOLATILITY_WINDOWS.length);
    await prisma.syncRun.deleteMany();
    await volReg.execute('volatility', backfillInput); // 续跑
    expect(await prisma.volatilityDaily.count({ where: { instrumentId: instId } })).toBe(volAfter1);

    // hot_snapshot 自然键 (instrumentId,hotType,dataDate): 相同 dataDate 再跑 → upsert 覆盖同行零净增。
    const hotReg = buildRegistry({ hotSnapshot: new HkHotMock(served, '2026-06-01') });
    await hotReg.execute('hot_snapshot', hotInput);
    const hotAfter1 = await prisma.hotSnapshot.count({ where: { instrumentId: instId } });
    expect(hotAfter1).toBe(HOT_TYPES.length);
    await prisma.syncRun.deleteMany();
    await hotReg.execute('hot_snapshot', hotInput); // 续跑 (同 dataDate)
    expect(await prisma.hotSnapshot.count({ where: { instrumentId: instId } })).toBe(hotAfter1);
  });

  // ── ⑤ p1/p2/A股无回归 + 2 维度 marketScope 纳入: 新维度只作用 hk, p1 eod_bar cn+hk 行为不变 ──
  it('⑤ p1/A股无回归: eod_bar 落 cn+hk (marketScope 不变) / volatility 只 hk、cn 不进工作集', async () => {
    const cnId = await seed('cn', '600519'); // A 股 — 040 维度 marketScope=hk 不该扫它
    const hkId = await seed('hk', '00700');

    // p1 eod_bar (marketScope=[cn,hk]): backfill 对 cn+hk 都落 DailyBar → 核心维度行为零回归。
    const eodMock = new ServedEodMock(new Set(['cn:600519', 'hk:00700']));
    await buildRegistry({ eodBar: eodMock }).execute('eod_bar', backfillInput);
    expect(await prisma.dailyBar.count({ where: { instrumentId: cnId } })).toBeGreaterThan(0);
    expect(await prisma.dailyBar.count({ where: { instrumentId: hkId } })).toBeGreaterThan(0);

    // 040 volatility (marketScope=[hk]): 工作集只 hk → cn 从不被 rangeCall (A股无回归), 只 hk 落库。
    const volatility = new HkVolatilityMock(new Set(['hk:00700']));
    const { stats } = await buildRegistry({ volatility }).execute('volatility', backfillInput);
    expect(stats.scanned).toBe(1); // 只 hk 一只进工作集 (cn 被 marketScope 过滤掉)
    expect(volatility.rangeCalls.every((c) => c.symbol === 'hk:00700')).toBe(true); // cn:600519 从不被请求
    expect(await prisma.volatilityDaily.count({ where: { instrumentId: cnId } })).toBe(0); // A股零行
    expect(await prisma.volatilityDaily.count({ where: { instrumentId: hkId } })).toBe(
      3 * VOLATILITY_WINDOWS.length,
    );
  });

  // ── ⑥ 经真队列 (Redis worker) CLI 单维度 job 续跑幂等 (回填自限速续跑, 经真调度面) ──────────
  it('⑥ volatility backfill 经队列 CLI 连跑两次 → concurrency=1 续跑不翻倍 (自然键幂等)', async () => {
    const instId = await seed('hk', '00700');
    const volatility = new HkVolatilityMock(new Set(['hk:00700']));
    const queue = new MarketdataSyncQueue(lifecycle.client, CFG);
    const worker = new MarketdataSyncWorker(
      lifecycle.client,
      buildRegistry({ volatility }),
      queue,
      CFG,
    );
    const events = new QueueEvents(MARKETDATA_SYNC_QUEUE, { connection: lifecycle.client });
    await events.waitUntilReady();
    worker.onModuleInit();
    try {
      const run = () =>
        executeBackfill(
          buildDeps(queue, events),
          { dryRun: false, dimension: 'volatility', historyDepth: 3650, markets: ['hk'] },
          NOW,
        );

      expect(await run()).toBe(0);
      const after1 = await prisma.volatilityDaily.count({ where: { instrumentId: instId } });
      expect(after1).toBe(3 * VOLATILITY_WINDOWS.length);

      await prisma.syncRun.deleteMany();
      expect(await run()).toBe(0); // 下一夜续跑
      expect(await prisma.volatilityDaily.count({ where: { instrumentId: instId } })).toBe(after1);
    } finally {
      await worker.onModuleDestroy();
      await events.close();
      await queue.onModuleDestroy();
    }
  });
});
