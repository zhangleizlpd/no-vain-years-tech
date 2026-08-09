import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { Logger } from '@nestjs/common';
import { QueueEvents } from 'bullmq';
import { PrismaService } from '../../src/security/prisma.service';
import { MockMarketDataAdapter } from '../../src/marketdata/mock-market-data.adapter';
import { SyncRunRecorder } from '../../src/marketdata/sync-run.recorder';
import { SyncTierRecalc } from '../../src/marketdata/sync-tier-recalc';
import { SyncUniverseUseCase } from '../../src/marketdata/sync-universe.usecase';
import { SyncProfileUseCase } from '../../src/marketdata/sync-profile.usecase';
import { DimensionExecutorRegistry, subtractDays } from '../../src/marketdata/dimension-executor';
import { splitBackfillWindows } from '../../src/marketdata/underlying-iv.rules';
import { shanghaiToday } from '../../src/marketdata/trading-day-gate';
import { BackfillPacer } from '../../src/marketdata/backfill-pacer';
import { VOLATILITY_WINDOWS } from '../../src/marketdata/lixinger-volatility.adapter';
import { QueueRedisLifecycle } from '../../src/marketdata/marketdata-queue-connection';
import {
  MARKETDATA_SYNC_QUEUE,
  MarketdataSyncQueue,
  MarketdataSyncWorker,
} from '../../src/marketdata/marketdata-sync.worker';
import { executeBackfill, type BackfillDeps } from '../../src/marketdata/marketdata-backfill.cli';
import type { EodBarPort } from '../../src/marketdata/eod-bar.port';
import type { MarketdataSyncConfig } from '../../src/config/marketdata.config';
import type { EodBarPoint, EodBarQuery } from '../../src/marketdata/marketdata.types';

const NOW = new Date('2026-06-03T12:00:00Z'); // 周三 (Asia/Shanghai 交易日)
const AS_OF = '2026-06-03';

const CFG: MarketdataSyncConfig = {
  backfillDefaultHistoryDays: 365,
  requeueDelayMs: 1_800_000,
  cliWaitTimeoutMs: 14_400_000,
  removeOnCompleteCount: 200,
  removeOnFailCount: 500,
  tickEnabled: false,
  optionCoverageThreshold: 1,
};

/** 可控虚拟时钟: sleep 推进时间, 让回填自限速无需真等待即可断言 (镜像 dual-window-rate-limiter.spec)。 */
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

// 038 T019 US3「保守多夜回填 pacing」集成 IT (Testcontainers PG+Redis, test-local hk mock):
// 证港股 10yr 回填温和安全 —— 不触风控、不干扰 A 股夜同步。覆盖 US3 四条 state_branch, 每条一 it():
//   ① backfill --markets hk --dry-run → 估算量级按 hk 吻合 (不入队不写库)。
//   ② 回填期自限速 → 有效 sustained rate ≤ ~600/min 目标内 (锚 T017 pacer, 不触 429)。
//   ③ 共享限流器串行 → hk 回填 job 与 cn 夜同步 job 同 queue concurrency=1 → 天然串行, 共享
//      令牌桶不被并发打爆 (无重叠 → maxActive=1)。
//   ④ 续跑幂等 → hk backfill 经队列连跑两次, 已同步不重复 (自然键幂等)。
//
// **vendor 边界 = test-local mock hk adapter** (非扩共享 MockMarketDataAdapter 塞 hk fixture —
// 后者 hk=no-data 护 T006 seam IT); 落库/幂等/队列串行经真 PG+Redis。
// 覆盖 spec state_branches: 回填自限速 / 共享限流器串行 / 幂等重跑。
describe('038 T019 US3 保守多夜回填 pacing (Testcontainers PG+Redis, test-local hk mock)', () => {
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
    await prisma.corporateAction.deleteMany();
    await prisma.instrument.deleteMany();
    await prisma.syncRun.deleteMany();
    // T003 migration 已把 6 维扩到 {cn,hk}; 每例回到已知基线 (marketScope 含 hk + 清水位)。
    await prisma.syncDimension.updateMany({
      data: { marketScope: ['cn', 'hk'], lastWatermark: null, enabled: true },
    });
    const q = new MarketdataSyncQueue(lifecycle.client, CFG);
    await q.queue.obliterate({ force: true });
    await q.queue.close();
  });

  /** eod bar fixture 行 (仅结构占位)。 */
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

  /**
   * test-local eod 端口: served 集内标的返 bar。delta (from==to) → 单 bar at targetDate;
   * backfill (from<to) → 区间多行历史 (含 to)。可选 onCall hook 供并发探针 (③)。
   */
  class ServedEodMock implements EodBarPort {
    constructor(
      private readonly served: ReadonlySet<string>,
      private readonly onCall?: () => Promise<void>,
    ) {}
    async getBars(query: EodBarQuery): Promise<EodBarPoint[]> {
      if (this.onCall) await this.onCall();
      if (!this.served.has(query.symbol)) return [];
      const to = query.to ?? AS_OF;
      const from = query.from ?? to;
      const candidates = from === to ? [to] : ['2026-05-15', '2026-05-29', to];
      return candidates.filter((d) => d >= from && d <= to).map((d) => bar(d, query.adjust));
    }
  }

  function buildRegistry(
    overrides: { eodBar?: EodBarPort; pacer?: BackfillPacer } = {},
  ): DimensionExecutorRegistry {
    const mock = new MockMarketDataAdapter();
    return new DimensionExecutorRegistry(
      new SyncUniverseUseCase(mock, prisma),
      new SyncProfileUseCase(mock, prisma),
      overrides.eodBar ?? mock,
      mock,
      mock,
      mock,
      prisma,
      new SyncRunRecorder(prisma),
      new SyncTierRecalc(prisma),
      overrides.pacer ?? BackfillPacer.disabled(),
    );
  }

  function buildDeps(queue: MarketdataSyncQueue, events: QueueEvents): BackfillDeps {
    return {
      prisma,
      syncQueue: queue,
      queueEvents: events,
      cliWaitTimeoutMs: 60_000,
      backfillDefaultHistoryDays: 365,
    };
  }

  /** seed N 只活跃标的 (currency 按 market), 返 canonical symbols。 */
  async function seed(market: string, n: number): Promise<string[]> {
    const symbols: string[] = [];
    for (let i = 1; i <= n; i++) {
      const code = `${market === 'hk' ? '0000' : '60000'}${i}`;
      await prisma.instrument.create({
        data: {
          market,
          code,
          name: `${market}${i}`,
          type: 'stock',
          currency: market === 'hk' ? 'HKD' : 'CNY',
          status: 'active',
        },
      });
      symbols.push(`${market}:${code}`);
    }
    return symbols;
  }

  // ── ① backfill --markets hk --dry-run 估算量级吻合 (估算按 hk) ──────────
  it('① backfill --markets hk --dry-run: 估算量级按 hk 吻合, 不入队不写库', async () => {
    await seed('hk', 3);
    await seed('cn', 2);
    const queue = new MarketdataSyncQueue(lifecycle.client, CFG);
    const events = new QueueEvents(MARKETDATA_SYNC_QUEUE, { connection: lifecycle.client });
    await events.waitUntilReady();
    const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    async function dryRunPlan(markets: string[]) {
      logSpy.mockClear();
      const code = await executeBackfill(buildDeps(queue, events), { dryRun: true, markets }, NOW);
      expect(code).toBe(0);
      const call = logSpy.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('estVendorRequests'),
      );
      if (!call || typeof call[0] !== 'string') throw new Error('backfill plan 未打印估算');
      return JSON.parse(call[0].replace('backfill plan: ', '')) as {
        markets: string[];
        estVendorRequests: number;
      };
    }

    try {
      // 估算公式 (与 estimateRequests 同源): eod=active×adjust + batched=2×⌈active/batch⌉ + corp=active
      // + 039 5 量化维度各 per-stock 单次 = active×5 (039 T017) + 040 volatility per-stock × 窗口数 =
      // active×VOLATILITY_WINDOWS.length (040 T010; hot_snapshot 是快照非历史回填, 不计入)
      // + 041 4 事件维度各 per-stock 单次区间 = active×4 (041 T016)
      // + 042 3 报告期维度各 per-stock 单次区间 = active×3 (042 T013)
      // + 043 announcement per-stock 单次区间 = active×1 (043 T010; industry_classification 覆盖式不计)。
      const eodDim = await prisma.syncDimension.findUniqueOrThrow({
        where: { dimensionKey: 'eod_bar' },
      });
      const fundDim = await prisma.syncDimension.findUniqueOrThrow({
        where: { dimensionKey: 'fundamental' },
      });
      const adjustCount = eodDim.adjustTypes.length > 0 ? eodDim.adjustTypes.length : 1;
      const batch = fundDim.batchSize > 0 ? fundDim.batchSize : 50;
      const QUANT_DIMENSION_COUNT = 5; // 039 T017: 5 新量化维度各 per-stock 单次调用
      const EVENT_DIMENSION_COUNT = 4; // 041 T016: 4 事件维度各 per-stock 单次区间调用
      const REPORT_DIMENSION_COUNT = 3; // 042 T013: 3 报告期维度各 per-stock 单次区间调用
      const CLASSIFICATION_DIMENSION_COUNT = 1; // 043 T010: announcement per-stock 单次区间 (industry_classification 覆盖式不计)
      // 046 T009: underlying_iv_daily 是**唯一 per-stock × 多页**的维度 (his_volatility 单次跨度
      // ≤364 天)。页数用与 estimateRequests / executor **同一个** splitBackfillWindows 派生 ——
      // 三处同源才不会出现「估算说 N 页、实跑 M 页」(#754 那类失配)。us_index_daily 覆盖式不计。
      const ivPages = splitBackfillWindows(
        subtractDays(shanghaiToday(NOW), CFG.backfillDefaultHistoryDays),
        shanghaiToday(NOW),
      ).length;
      const expectFor = (active: number) =>
        active * adjustCount +
        2 * Math.ceil(active / batch) +
        active +
        active * QUANT_DIMENSION_COUNT +
        active * VOLATILITY_WINDOWS.length + // 040 T010: 波动率 per-stock × 窗口数
        active * EVENT_DIMENSION_COUNT + // 041 T016: 4 事件维度 per-stock 单次区间
        active * REPORT_DIMENSION_COUNT + // 042 T013: 3 报告期维度 per-stock 单次区间
        active * CLASSIFICATION_DIMENSION_COUNT + // 043 T010: announcement per-stock 单次区间
        active + // sellput-viz: us_equity_bar per-stock 单次 kline 区间
        active * ivPages; // 046 T009: underlying_iv_daily per-stock × his_volatility 页数

      const hkPlan = await dryRunPlan(['hk']);
      expect(hkPlan.markets).toEqual(['hk']);
      expect(hkPlan.estVendorRequests).toBe(expectFor(3)); // 按 hk active=3 吻合

      const cnPlan = await dryRunPlan(['cn']);
      expect(cnPlan.estVendorRequests).toBe(expectFor(2)); // cn active=2 → 不同 = 证透传
      expect(hkPlan.estVendorRequests).toBeGreaterThan(cnPlan.estVendorRequests); // 量级随 hk 计数
    } finally {
      logSpy.mockRestore();
      await events.close();
      await queue.onModuleDestroy();
    }

    // dry-run 不入队不写库。
    const q = new MarketdataSyncQueue(lifecycle.client, CFG);
    expect(await q.queue.count()).toBe(0);
    await q.queue.close();
    expect(await prisma.syncRun.count()).toBe(0);
    expect(await prisma.dailyBar.count()).toBe(0);
  });

  // ── ② 回填期自限速在目标内 → 有效速率 ≤ ~600/min (不触 429) ────────────
  it('② 回填期自限速: hk eod_bar backfill 有效 sustained rate ≤ 600/min 目标内 (不触 429)', async () => {
    const served = new Set(await seed('hk', 6));
    const clock = makeClock(0);
    // enabled pacer (600/min, jitter=0 隔离基础节流) + 注入虚拟时钟观测节流耗时。
    const pacer = new BackfillPacer(
      { targetPerMin: 600, jitterMs: 0 },
      clock.now,
      clock.sleep,
      () => 0,
    );
    const reg = buildRegistry({ eodBar: new ServedEodMock(served), pacer });

    const { stats } = await reg.execute('eod_bar', {
      mode: 'backfill',
      asOf: AS_OF,
      now: NOW,
      backfillHistoryDays: 30,
    });

    const K = served.size;
    // 6 只 hk 各 pace 一次: 首个免等 + 其余 5 次各 sleep 100ms → 节流耗时 ≥ (K-1)×100。
    expect(clock.sleeps.length).toBe(K - 1);
    expect(clock.t).toBeGreaterThanOrEqual((K - 1) * 100);
    // 稳态速率 ≤ 目标 600/min = 不触 vendor 分钟级封禁 (429) 的机制保证。
    const sustainedPerMin = (K - 1) / (clock.t / 60_000);
    expect(sustainedPerMin).toBeLessThanOrEqual(600 + 1e-6);
    // 全程无 429 / 错误上浮 (自限速 + mock 确定响应)。
    expect(stats.failed).toBe(0);
    expect(await prisma.dailyBar.count()).toBe(K * 3); // 6 只 × 3 行区间历史
  });

  // ── ③ 共享限流器串行: hk 回填 job 与 cn 夜同步 job concurrency=1 不并发 ──
  it('③ 共享限流器串行: hk 回填 job 与 cn 夜同步 job 同 queue concurrency=1 → 无并发重叠', async () => {
    const hk = await seed('hk', 3);
    const cn = await seed('cn', 3);
    const served = new Set([...hk, ...cn]);

    // 并发探针: getBars 进出各标记 active, 记录峰值 (concurrency=1 → 恒 1, 无跨 job 重叠)。
    let active = 0;
    let maxActive = 0;
    const trackingEod = new ServedEodMock(served, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10)); // 制造重叠窗口: concurrency>1 会击穿到 2
      active--;
    });

    const queue = new MarketdataSyncQueue(lifecycle.client, CFG);
    const worker = new MarketdataSyncWorker(
      lifecycle.client,
      buildRegistry({ eodBar: trackingEod }),
      queue,
      CFG,
    );
    const events = new QueueEvents(MARKETDATA_SYNC_QUEUE, { connection: lifecycle.client });
    await events.waitUntilReady();
    worker.onModuleInit();
    try {
      const jobA = await queue.enqueueDimensionJob(
        {
          dimensionKey: 'eod_bar',
          mode: 'backfill',
          asOf: AS_OF,
          backfillHistoryDays: 30,
          markets: ['hk'],
          triggeredBy: 'cli',
        },
        { retryMax: 1 },
      );
      const jobB = await queue.enqueueDimensionJob(
        {
          dimensionKey: 'eod_bar',
          mode: 'delta',
          asOf: AS_OF,
          markets: ['cn'],
          triggeredBy: 'tick',
        },
        { retryMax: 1 },
      );
      await Promise.all([
        jobA.waitUntilFinished(events, 30_000),
        jobB.waitUntilFinished(events, 30_000),
      ]);

      // concurrency=1 → 两 job 天然串行, getBars 从不并发 → 共享令牌桶不被并发打爆。
      expect(maxActive).toBe(1);
      // 两 job 都成功 + 两市场都落库 (hk 回填 3×3 + cn delta 3×1)。
      const runs = await prisma.syncRun.findMany({ where: { syncType: 'sync:eod_bar' } });
      expect(runs.length).toBe(2);
      expect(runs.every((r) => r.status === 'success')).toBe(true);
      const hkRows = await prisma.dailyBar.count({ where: { instrument: { market: 'hk' } } });
      const cnRows = await prisma.dailyBar.count({ where: { instrument: { market: 'cn' } } });
      expect(hkRows).toBe(3 * 3);
      expect(cnRows).toBe(3 * 1);
    } finally {
      await worker.onModuleDestroy();
      await events.close();
      await queue.onModuleDestroy();
    }
  });

  // ── ④ 续跑幂等: hk backfill 经队列连跑两次不重复 ────────────────────────
  it('④ 续跑幂等: hk backfill 经队列连跑两次 → 已同步不重复 (自然键幂等)', async () => {
    const served = new Set(await seed('hk', 4));
    const queue = new MarketdataSyncQueue(lifecycle.client, CFG);
    const worker = new MarketdataSyncWorker(
      lifecycle.client,
      buildRegistry({ eodBar: new ServedEodMock(served) }),
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
          { dryRun: false, dimension: 'eod_bar', historyDepth: 30, markets: ['hk'] },
          NOW,
        );

      expect(await run()).toBe(0);
      const after1 = await prisma.dailyBar.count();
      expect(after1).toBe(4 * 3); // 4 只 hk × 3 行区间历史

      await prisma.syncRun.deleteMany();
      expect(await run()).toBe(0); // 下一夜续跑
      expect(await prisma.dailyBar.count()).toBe(after1); // 零新增行 = 自然键幂等
    } finally {
      await worker.onModuleDestroy();
      await events.close();
      await queue.onModuleDestroy();
    }
  });
});
