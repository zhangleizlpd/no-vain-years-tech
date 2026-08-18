import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { coldStartUnused } from '../_support/cold-start-stub';
import { QueueEvents } from 'bullmq';
import { PrismaService } from '../../src/security/prisma.service';
import { MockMarketDataAdapter } from '../../src/marketdata/mock-market-data.adapter';
import { SyncRunRecorder } from '../../src/marketdata/sync-run.recorder';
import { SyncTierRecalc } from '../../src/marketdata/sync-tier-recalc';
import { SyncUniverseUseCase } from '../../src/marketdata/sync-universe.usecase';
import { SyncProfileUseCase } from '../../src/marketdata/sync-profile.usecase';
import {
  DIMENSION_KEYS,
  DimensionExecutorRegistry,
  type DimensionKey,
} from '../../src/marketdata/dimension-executor';
import { QueueRedisLifecycle } from '../../src/marketdata/marketdata-queue-connection';
import {
  MARKETDATA_SYNC_QUEUE,
  MarketdataSyncQueue,
} from '../../src/marketdata/marketdata-sync.queue';
import { MarketdataSyncWorker } from '../../src/marketdata/marketdata-sync.worker';
import { SyncTickDriver } from '../../src/marketdata/sync-tick-driver';
import { CalendarHitCheck } from '../../src/marketdata/calendar-hit-check';
import type { TradingCalendarPort } from '../../src/marketdata/trading-calendar.port';
import type { MarketdataSyncConfig } from '../../src/config/marketdata.config';

const NOW = new Date('2026-06-03T12:00:00Z'); // 周三 (Asia/Shanghai 交易日)
const TEST_KEY = 'test_dimension' as DimensionKey;

const CFG: MarketdataSyncConfig = {
  backfillDefaultHistoryDays: 365,
  requeueDelayMs: 1_800_000,
  cliWaitTimeoutMs: 14_400_000,
  removeOnCompleteCount: 200,
  removeOnFailCount: 500,
  tickEnabled: false,
  optionCoverageThreshold: 1,
};

const calendarStub: TradingCalendarPort = {
  classify: async () => 'trading',
  lastClosedSession: async () => null,
};

// 019 T006 SC-S05 配置化门 (US3/FR-S07): 注册一个测试维度 = registerExecutor + 一行
// sync_dimension seed (IT 内临时行, 不进 seed migration) → tick claim → 派生序组 flow →
// worker named-job 路由执行 — 全链零 switch/全序常量改动。演练结论:
// 「加新维度 = 注册 executor + 一行 seed (+ 可选依赖边)」。
describe('019 T006 SC-S05 测试维度注册演练 (tick→flow→worker 全链)', () => {
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

  function buildRegistry(): DimensionExecutorRegistry {
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
    );
  }

  it('注册 executor + 一行 seed → tick 抢占 → 派生序组 flow → worker 路由执行 → 清理', async () => {
    // ① 一行 seed (IT 临时行, priority 4 入派生序尾; 与 eod_bar 同 due 验证链装配)。
    await prisma.syncDimension.create({
      data: {
        dimensionKey: TEST_KEY,
        enabled: true,
        cronExpr: '0 0 22 * * *',
        vendor: 'mock',
        marketScope: ['cn'],
        adjustTypes: [],
        batchSize: 1,
        priority: 4,
        nextFireAt: new Date(NOW.getTime() - 60_000), // due。
      },
    });
    await prisma.syncDimension.update({
      where: { dimensionKey: 'eod_bar' },
      data: { nextFireAt: new Date(NOW.getTime() - 60_000) }, // 同 due (其余 NULL 仅懒初始化)。
    });

    // ② 注册 executor (零 switch/常量改动 — 本 IT 的 diff 面即 SC-S05 证据)。
    const registry = buildRegistry();
    const testExecutor = vi.fn(async () => ({
      stats: { scanned: 1, ok: 1, skipped: 0, failed: 0, failedTargets: [] },
      budgetExhausted: false,
    }));
    registry.registerExecutor(TEST_KEY, testExecutor);

    const queue = new MarketdataSyncQueue(lifecycle.client, CFG);
    const worker = new MarketdataSyncWorker(
      lifecycle.client,
      registry,
      queue,
      coldStartUnused(),
      CFG,
    );
    const events = new QueueEvents(MARKETDATA_SYNC_QUEUE, { connection: lifecycle.client });
    await events.waitUntilReady();
    worker.onModuleInit();
    try {
      // ③ tick 全链: claim won (eod_bar + test_dimension) → 派生序 (priority 6 > 4 →
      // eod 在前) 组嵌套链 → 入队。
      const driver = new SyncTickDriver(
        prisma,
        queue,
        calendarStub,
        CFG,
        new CalendarHitCheck(),
        new SyncRunRecorder(prisma),
      );
      const result = await driver.tick(NOW);
      expect(result.fired.sort()).toEqual(['eod_bar', TEST_KEY]);

      // ④ worker 消费: root = 派生序后者 (test_dimension), 等 root 终态 = 整链终态。
      const roots = await queue.queue.getJobs(['waiting-children', 'waiting', 'active']);
      const rootJob = roots.find((j) => j.name === `sync:${TEST_KEY}`);
      expect(rootJob).toBeDefined();
      await rootJob!.waitUntilFinished(events, 60_000);

      // ⑤ 路由断言: 注册的 executor 被调 + SyncRun 审计行落库 (sync:test_dimension)。
      expect(testExecutor).toHaveBeenCalledTimes(1);
      const runs = await prisma.syncRun.findMany({ where: { syncType: `sync:${TEST_KEY}` } });
      expect(runs).toHaveLength(1);
      expect(runs[0]?.status).toBe('success');
      expect(runs[0]?.ok).toBe(1);
      // eod_bar 链内照常执行 (sync:eod_bar 审计行在场 — 派生序装配未破既有维度)。
      expect(await prisma.syncRun.count({ where: { syncType: 'sync:eod_bar' } })).toBe(1);
    } finally {
      await worker.onModuleDestroy?.();
      await events.close();
      await queue.queue.obliterate({ force: true });
      await queue.onModuleDestroy();
      // ⑥ 临时行清理断言: 测试维度不进 seed ⇒ 删掉后行数回落到「注册表在册的那些」。
      // 从 DIMENSION_KEYS 派生 —— 这里要钉的是「临时行确实被清掉了」, 不是 seed 有多少行。
      await prisma.syncDimension.delete({ where: { dimensionKey: TEST_KEY } });
      expect(await prisma.syncDimension.count()).toBe(DIMENSION_KEYS.length);
    }
  }, 120_000);
});
