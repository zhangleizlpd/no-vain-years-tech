import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { coldStartUnused } from '../_support/cold-start-stub';
import { Logger } from '@nestjs/common';
import { QueueEvents } from 'bullmq';
import { PrismaService } from '../../src/security/prisma.service';
import { MockMarketDataAdapter } from '../../src/marketdata/mock-market-data.adapter';
import { SyncRunRecorder } from '../../src/marketdata/sync-run.recorder';
import { SyncTierRecalc } from '../../src/marketdata/sync-tier-recalc';
import { SyncUniverseUseCase } from '../../src/marketdata/sync-universe.usecase';
import { SyncProfileUseCase } from '../../src/marketdata/sync-profile.usecase';
import { DimensionExecutorRegistry } from '../../src/marketdata/dimension-executor';
import { QueueRedisLifecycle } from '../../src/marketdata/marketdata-queue-connection';
import {
  MARKETDATA_SYNC_QUEUE,
  MARKETDATA_WORKER_DISABLED,
  MarketdataSyncQueue,
} from '../../src/marketdata/marketdata-sync.queue';
import { MarketdataSyncWorker } from '../../src/marketdata/marketdata-sync.worker';
import { executeTrigger, type TriggerDeps } from '../../src/marketdata/marketdata-trigger.cli';
import type { MarketdataSyncConfig } from '../../src/config/marketdata.config';

const NOW = new Date('2026-06-03T12:00:00Z'); // 周三 (Asia/Shanghai 交易日)

/**
 * 夜间轮时刻: 周四 06:30 Asia/Shanghai = 周三 18:30 ET —— **us 已收盘**。
 *
 * 🚨 凡是把 `option_daily_snapshot` 一并入队的用例必须用它, 不能用文件级 `NOW`(ET 08:00 盘前):
 * 手动补采时点闸会拒绝入队 (2026-08-17 prod 实撞, 见 manual-sync-session-guard.ts)。
 * 「盘前跑全维度」在生产里本就是一条不该成立的命令 —— 那正是本闸要拦的东西。
 */
const NOW_AFTER_US_CLOSE = new Date('2026-06-03T22:30:00Z');

const CFG: MarketdataSyncConfig = {
  backfillDefaultHistoryDays: 365,
  requeueDelayMs: 1_800_000,
  cliWaitTimeoutMs: 14_400_000,
  removeOnCompleteCount: 200,
  removeOnFailCount: 500,
  tickEnabled: false,
  futuLaneEnabled: false, // 灰度默认关 ⇒ 全部 job 落 default lane (拆 lane 前的行为)。
  optionCoverageThreshold: 1,
};

// 017 T017+T019 PR-5 trigger CLI IT (Testcontainers PG+Redis, 进程内 Queue/Worker 蓝本
// dimension-worker): executeTrigger 纯逻辑直测 — 退出码三态 (0 成功 / 1 job 失败 / 2 等待
// 超时+可操作信息, FR-S15a) + cascade flow 成员 (传递性下游, 不含上游) + CLI 与自动 job
// 同 queue 串行互斥 (concurrency=1) + sentinel 置位不消费 (D6, SC-S06)。
describe('017 T017+T019 trigger CLI (退出码三态 + cascade + 互斥 + sentinel)', () => {
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
    await prisma.fundamentalSnapshot.deleteMany();
    await prisma.financialMetric.deleteMany();
    await prisma.corporateAction.deleteMany();
    await prisma.instrument.deleteMany();
    await prisma.syncRun.deleteMany();
    const q = new MarketdataSyncQueue(lifecycle.client, CFG);
    await q.queue.obliterate({ force: true });
    await q.queue.close();
  });

  function buildRegistry(profile?: SyncProfileUseCase): DimensionExecutorRegistry {
    const mock = new MockMarketDataAdapter();
    return new DimensionExecutorRegistry(
      new SyncUniverseUseCase(mock, prisma),
      profile ?? new SyncProfileUseCase(mock, prisma),
      mock,
      mock,
      mock,
      mock,
      prisma,
      new SyncRunRecorder(prisma),
      new SyncTierRecalc(prisma),
    );
  }

  function buildDeps(queue: MarketdataSyncQueue, events: QueueEvents): TriggerDeps {
    return { prisma, syncQueue: queue, queueEvents: events, cliWaitTimeoutMs: 30_000 };
  }

  it('① 成功: trigger universe → job 完成 → 退出码 0 + SyncRun sync:universe success', async () => {
    const queue = new MarketdataSyncQueue(lifecycle.client, CFG);
    const worker = new MarketdataSyncWorker(
      lifecycle.client,
      buildRegistry(),
      queue,
      coldStartUnused(),
      CFG,
      new SyncRunRecorder(prisma),
    );
    const events = new QueueEvents(MARKETDATA_SYNC_QUEUE, { connection: lifecycle.client });
    await events.waitUntilReady();
    worker.onModuleInit();
    try {
      const code = await executeTrigger(
        buildDeps(queue, events),
        { dimension: 'universe', cascade: false },
        NOW,
      );
      expect(code).toBe(0);
      expect(await prisma.instrument.count()).toBeGreaterThan(0);
      const run = await prisma.syncRun.findFirst({ where: { syncType: 'sync:universe' } });
      expect(run?.status).toBe('success');
    } finally {
      await worker.onModuleDestroy();
      await events.close();
      await queue.onModuleDestroy();
    }
  });

  it('② 失败: processor 顶层抛错 (retryMax=1 快速耗尽) → 退出码 1 + SyncRun failed', async () => {
    const queue = new MarketdataSyncQueue(lifecycle.client, CFG);
    // 失败注入: profile use case run() 拒绝 → executor 顶层 throw → job failed。
    const broken = {
      run: () => Promise.reject(new Error('boom')),
    } as unknown as SyncProfileUseCase;
    const worker = new MarketdataSyncWorker(
      lifecycle.client,
      buildRegistry(broken),
      queue,
      coldStartUnused(),
      CFG,
      new SyncRunRecorder(prisma),
    );
    const events = new QueueEvents(MARKETDATA_SYNC_QUEUE, { connection: lifecycle.client });
    await events.waitUntilReady();
    worker.onModuleInit();
    await prisma.syncDimension.update({
      where: { dimensionKey: 'profile' },
      data: { retryMax: 1 }, // 不 retry — 否则 60s 指数退避拖慢 IT (attempts 语义 worker IT 已断)。
    });
    try {
      const code = await executeTrigger(
        buildDeps(queue, events),
        { dimension: 'profile', cascade: false },
        NOW,
      );
      expect(code).toBe(1);
      const run = await prisma.syncRun.findFirst({ where: { syncType: 'sync:profile' } });
      expect(run?.status).toBe('failed');
    } finally {
      await prisma.syncDimension.update({
        where: { dimensionKey: 'profile' },
        data: { retryMax: 3 },
      });
      await worker.onModuleDestroy();
      await events.close();
      await queue.onModuleDestroy();
    }
  });

  it('④ cascade universe 根 → flow 含全部传递性下游 (29 维度全链执行, FR-S15)', async () => {
    const queue = new MarketdataSyncQueue(lifecycle.client, CFG);
    const worker = new MarketdataSyncWorker(
      lifecycle.client,
      buildRegistry(),
      queue,
      coldStartUnused(),
      CFG,
      new SyncRunRecorder(prisma),
    );
    const events = new QueueEvents(MARKETDATA_SYNC_QUEUE, { connection: lifecycle.client });
    await events.waitUntilReady();
    worker.onModuleInit();
    try {
      const code = await executeTrigger(
        buildDeps(queue, events),
        { dimension: 'universe', cascade: true },
        NOW_AFTER_US_CLOSE,
      );
      expect(code).toBe(0);
      // 闭包 = universe + 全 26 下游 (seed 28 边传递闭包, 含 039 5 + 040 2 + 041 4 + 042 3 + 043 2 港股维度
      // + 046 underlying_iv_daily + 047 option_contract/option_daily_snapshot/earnings_event), 全链 per-dim SyncRun 落行。
      // 🚨 046 us_index_daily **不在闭包内** —— 它无 universe 入边 (FR-027 刻意), cascade 触达不到它。
      // 这正是「指数不依赖锚/不依赖标的注册」在调度图上的可观测后果, 不是漏项。
      const runs = await prisma.syncRun.findMany();
      expect(runs.map((r) => r.syncType).sort()).toEqual(
        [
          'sync:universe',
          'sync:us_equity_bar', // sellput-viz
          'sync:profile',
          'sync:fundamental',
          'sync:hk_option_contract', // 066 T04
          'sync:hk_option_daily_snapshot', // 066 T04
          'sync:hk_underlying_iv_daily', // 066 T04
          'sync:financial',
          'sync:eod_bar',
          'sync:corporate_action',
          'sync:short_selling', // 039
          'sync:connect_holding', // 039
          'sync:fund_holding', // 039
          'sync:fund_company_holding', // 039
          'sync:index_membership', // 039
          'sync:volatility', // 040
          'sync:hot_snapshot', // 040
          'sync:buyback', // 041
          'sync:equity_change', // 041
          'sync:shareholder_change', // 041
          'sync:allotment', // 041
          'sync:revenue_segment', // 042
          'sync:shareholder_snapshot', // 042
          'sync:employee', // 042
          'sync:industry_classification', // 043
          'sync:announcement', // 043
          'sync:underlying_iv_daily', // 046 (universe→underlying_iv_daily soft 边在闭包内)
          // 047: universe→option_contract soft + option_contract→option_daily_snapshot hard
          // ⇒ 两者均在传递闭包内; universe→earnings_event soft 同理。
          'sync:option_contract', // 047
          'sync:option_daily_snapshot', // 047
          'sync:earnings_event', // 047
        ].sort(),
      );
      expect(runs.every((r) => r.status === 'success')).toBe(true);
      expect(runs.every((r) => r.bullJobId !== null)).toBe(true);
    } finally {
      await worker.onModuleDestroy();
      await events.close();
      await queue.onModuleDestroy();
    }
  });

  it('⑤ cascade profile 根 → 仅 fundamental 下游, 不含上游 universe (FR-S15)', async () => {
    const queue = new MarketdataSyncQueue(lifecycle.client, CFG);
    const worker = new MarketdataSyncWorker(
      lifecycle.client,
      buildRegistry(),
      queue,
      coldStartUnused(),
      CFG,
      new SyncRunRecorder(prisma),
    );
    const events = new QueueEvents(MARKETDATA_SYNC_QUEUE, { connection: lifecycle.client });
    await events.waitUntilReady();
    worker.onModuleInit();
    try {
      const code = await executeTrigger(
        buildDeps(queue, events),
        { dimension: 'profile', cascade: true },
        NOW,
      );
      expect(code).toBe(0);
      // 闭包只沿 downstream 走: {profile, fundamental} — 已成功上游 universe 不重跑。
      const runs = await prisma.syncRun.findMany();
      expect(runs.map((r) => r.syncType).sort()).toEqual(['sync:fundamental', 'sync:profile']);
    } finally {
      await worker.onModuleDestroy();
      await events.close();
      await queue.onModuleDestroy();
    }
  });

  it('⑥ CLI job 与自动入队 job 同 queue 串行 (concurrency=1 互斥, 无并发执行窗)', async () => {
    const queue = new MarketdataSyncQueue(lifecycle.client, CFG);
    // 慢 profile 执行器 (300ms) + 并发计数器: 同 queue 两 job 若并行 → maxActive>1。
    let active = 0;
    let maxActive = 0;
    const slowProfile = {
      run: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 300));
        active--;
        return { scanned: 0, ok: 0, skipped: 0, failed: 0, findings: [] };
      },
    } as unknown as SyncProfileUseCase;
    const worker = new MarketdataSyncWorker(
      lifecycle.client,
      buildRegistry(slowProfile),
      queue,
      coldStartUnused(),
      CFG,
      new SyncRunRecorder(prisma),
    );
    const events = new QueueEvents(MARKETDATA_SYNC_QUEUE, { connection: lifecycle.client });
    await events.waitUntilReady();
    worker.onModuleInit();
    try {
      // 自动 job (tick 形态直入队) 与 CLI trigger 并发提交 → 同 queue 串行消费。
      const autoJob = await queue.enqueueDimensionJob(
        { dimensionKey: 'profile', mode: 'delta', asOf: '2026-06-03', triggeredBy: 'tick' },
        { retryMax: 3 },
      );
      const [, code] = await Promise.all([
        autoJob.waitUntilFinished(events, 30_000),
        executeTrigger(buildDeps(queue, events), { dimension: 'profile', cascade: false }, NOW),
      ]);
      expect(code).toBe(0);
      expect(maxActive).toBe(1); // 任意时刻至多一个 executor 在跑 — 互斥成立。
      expect(await prisma.syncRun.count({ where: { syncType: 'sync:profile' } })).toBe(2);
    } finally {
      await worker.onModuleDestroy();
      await events.close();
      await queue.onModuleDestroy();
    }
  });

  it('⑦ sentinel 置位 (CLI 进程形态) → worker 不启动, trigger 超时积压不消费 (D6)', async () => {
    const queue = new MarketdataSyncQueue(lifecycle.client, CFG);
    process.env[MARKETDATA_WORKER_DISABLED] = '1';
    const worker = new MarketdataSyncWorker(
      lifecycle.client,
      buildRegistry(),
      queue,
      coldStartUnused(),
      CFG,
      new SyncRunRecorder(prisma),
    );
    const events = new QueueEvents(MARKETDATA_SYNC_QUEUE, { connection: lifecycle.client });
    await events.waitUntilReady();
    try {
      worker.onModuleInit();
      expect(worker.running).toBe(false); // sentinel → onModuleInit no-op。

      const code = await executeTrigger(
        buildDeps(queue, events),
        { dimension: 'universe', cascade: false, timeoutMs: 500 },
        NOW,
      );
      expect(code).toBe(2); // 本进程只入队不消费 → 等待超时。
      expect(await queue.queue.getWaitingCount()).toBe(1); // 积压未被消费。
      expect(await prisma.syncRun.count()).toBe(0);
    } finally {
      delete process.env[MARKETDATA_WORKER_DISABLED];
      await worker.onModuleDestroy();
      await events.close();
      await queue.onModuleDestroy();
    }
  });

  it('③ 超时: 无 worker (CLI 不起 worker, D6) → 退出码 2 + 可操作错误信息 + job 仍积压', async () => {
    const queue = new MarketdataSyncQueue(lifecycle.client, CFG);
    const events = new QueueEvents(MARKETDATA_SYNC_QUEUE, { connection: lifecycle.client });
    await events.waitUntilReady();
    const errorSpy = vi.spyOn(Logger.prototype, 'error');
    try {
      const code = await executeTrigger(
        buildDeps(queue, events),
        { dimension: 'universe', cascade: false, timeoutMs: 500 }, // --timeout 覆盖 config
        NOW,
      );
      expect(code).toBe(2);
      // FR-S15a: 非 0 退出 + 可操作错误信息 (不静默挂起)。
      const hit = errorSpy.mock.calls.some(
        (c) => typeof c[0] === 'string' && c[0].includes('worker 不在线'),
      );
      expect(hit).toBe(true);
      expect(await queue.queue.getWaitingCount()).toBe(1); // 入队成功, 只是没人消费。
      expect(await prisma.syncRun.count()).toBe(0);
    } finally {
      errorSpy.mockRestore();
      await events.close();
      await queue.onModuleDestroy();
    }
  });

  /**
   * 时点闸的**接线**断言 (2026-08-17 prod 实撞)。纯函数判据在
   * `manual-sync-session-guard.spec.ts` 里逐格钉过了; 这里只钉一件事: **CLI 真的接上了它**,
   * 而且拦在**入队之前** —— 入队之后再拦, 错行已经有一半机会落库。
   */
  it('🚨 盘前跑 option_daily_snapshot ⇒ 拒绝入队, 队列零 job (2026-08-17 事故)', async () => {
    const queue = new MarketdataSyncQueue(lifecycle.client, CFG);
    const events = new QueueEvents(MARKETDATA_SYNC_QUEUE, { connection: lifecycle.client });
    await events.waitUntilReady();
    try {
      // NOW = ET 08:00, 距 16:00 收盘还有 8 小时 —— 与事故时刻同形。
      await expect(
        executeTrigger(
          buildDeps(queue, events),
          { dimension: 'option_daily_snapshot', cascade: false },
          NOW,
        ),
      ).rejects.toThrow(/尚未收盘/);

      // 判据不是"抛了就行": 一个 job 都不许进队列, 否则 worker 那侧照样会跑。
      expect(await queue.queue.getJobCountByTypes('waiting', 'active', 'delayed')).toBe(0);
      expect(await prisma.syncRun.count()).toBe(0);
    } finally {
      await events.close();
      await queue.queue.close();
    }
  });
});
