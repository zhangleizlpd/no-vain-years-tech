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
import type { MarketdataSyncConfig } from '../../src/config/marketdata.config';

const AS_OF = '2026-06-03';

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

// 017 T009 PR-3 worker IT (Testcontainers PG+Redis, 进程内 new Queue/Worker 蓝本
// queue-infra): 入队 helper opts 注入 (attempts=retryMax + backoff + removeOn*) →
// processor 按 job.name 路由 executor per-dim 路径 (落库 + SyncRun sync:<dim> +
// bullJobId) → sentinel 置位 boot 不起 worker (D6, CLI 进程形态)。
describe('017 T009 marketdata-sync worker (enqueue → route → per-dim 落库)', () => {
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
    await prisma.watchlistItem.deleteMany();
    await prisma.group.deleteMany();
    // 清队列残留 (跨用例隔离)。
    const q = new MarketdataSyncQueue(lifecycle.client, CFG);
    await q.queue.obliterate({ force: true });
    await q.queue.close();
  });

  function buildRegistry(tierRecalc?: SyncTierRecalc): DimensionExecutorRegistry {
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
      tierRecalc ?? new SyncTierRecalc(prisma),
    );
  }

  it('① 入队 universe job → worker 路由 executor → instrument 落库 + SyncRun sync:universe (bullJobId=job.id) + attempts 注入', async () => {
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
      const job = await queue.enqueueDimensionJob(
        { dimensionKey: 'universe', mode: 'delta', asOf: AS_OF, triggeredBy: 'cli' },
        { retryMax: 3, lane: 'default' },
      );
      // job opts 注入断言 (attempts=retryMax + backoff + removeOn* 走 config)。
      expect(job.opts.attempts).toBe(3);
      expect(job.opts.backoff).toEqual({ type: 'exponential', delay: 60_000 });
      expect(job.opts.removeOnComplete).toEqual({ count: 200 });
      expect(job.opts.removeOnFail).toEqual({ count: 500 });

      await job.waitUntilFinished(events, 30_000);
      expect(await prisma.instrument.count()).toBeGreaterThan(0);
      const run = await prisma.syncRun.findFirst({ where: { syncType: 'sync:universe' } });
      expect(run?.status).toBe('success');
      expect(run?.bullJobId).toBe(job.id);
    } finally {
      await worker.onModuleDestroy();
      await events.close();
      await queue.onModuleDestroy();
    }
  });

  it('② sentinel 置位 → onModuleInit 不起 worker, 队列积压不消费 (D6 CLI 进程形态)', async () => {
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
    try {
      worker.onModuleInit();
      expect(worker.running).toBe(false);

      await queue.enqueueDimensionJob(
        { dimensionKey: 'universe', mode: 'delta', asOf: AS_OF, triggeredBy: 'cli' },
        { retryMax: 1, lane: 'default' },
      );
      await new Promise((r) => setTimeout(r, 500)); // 给「若误启动的 worker」消费窗口。
      expect(await queue.queue.getWaitingCount()).toBe(1); // 仍积压 — 没人消费。
      expect(await prisma.syncRun.count()).toBe(0);
    } finally {
      delete process.env[MARKETDATA_WORKER_DISABLED];
      await worker.onModuleDestroy();
      await queue.onModuleDestroy();
    }
  });

  it('④ 配额耗尽 → standalone delayed re-enqueue (deferral ≠ failure) + 已同步标的续跑不重复 (D5)', async () => {
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
      // 先种 universe (3 标的: 600519 有 bar / 000001 / 430047 无)。
      const uJob = await queue.enqueueDimensionJob(
        { dimensionKey: 'universe', mode: 'delta', asOf: '2026-06-01', triggeredBy: 'cli' },
        { retryMax: 1, lane: 'default' },
      );
      await uJob.waitUntilFinished(events, 30_000);

      // 配额 1: 第一窗只处理 600519 (id 序首位) → 耗尽 → 顺延 re-enqueue。
      // asOf=2026-06-01 与 mock bar tradeDate 对齐 (pendingEodInstruments 进度锚生效)。
      const job = await queue.enqueueDimensionJob(
        {
          dimensionKey: 'eod_bar',
          mode: 'delta',
          asOf: '2026-06-01',
          maxEodInstruments: 1,
          triggeredBy: 'cli',
        },
        { retryMax: 2, lane: 'default' },
      );
      await job.waitUntilFinished(events, 30_000);

      // deferral ≠ failure: job 正常完成 (不耗 attempts), 顺延以 delayed job 形态存在。
      const delayed = await queue.queue.getDelayed();
      expect(delayed).toHaveLength(1);
      expect(delayed[0]?.name).toBe('sync:eod_bar');
      expect(delayed[0]?.opts.delay).toBe(CFG.requeueDelayMs);
      // payload 原样保留 —— **配额参数不漂移**。
      expect(delayed[0]?.data.maxEodInstruments).toBe(1);
      // 🚨 唯一的例外是 `triggeredBy` (#202): 顺延跑出来的是**同一轮的重入**, 而它会开出第二行
      // sync_run。继续继承原触发源 (这里是 'cli') 就等于让「连续 N 轮」的计数器把一轮数成两轮
      // —— 原触发源已由第一行记下, 第二行要如实说自己是顺延来的。
      expect(delayed[0]?.data.triggeredBy).toBe('requeue');

      // 第一窗已落 600519 none 1 行 (020 T008 单口径)。
      const barsAfterFirst = await prisma.dailyBar.count();
      expect(barsAfterFirst).toBe(1);

      // promote 顺延 job 立即续跑 → 600519 已同步不重复 (幂等锚), bar 数不变。
      await delayed[0]?.promote();
      await delayed[0]?.waitUntilFinished(events, 30_000);
      expect(await prisma.dailyBar.count()).toBe(barsAfterFirst);
      // 续跑窗自管独立 per-dim SyncRun 行 (两窗两行)。
      expect(await prisma.syncRun.count({ where: { syncType: 'sync:eod_bar' } })).toBe(2);
    } finally {
      await worker.onModuleDestroy();
      await events.close();
      await queue.onModuleDestroy();
    }
  });

  it('⑤ 双 job 失败不连坐: 维度 A 顶层抛错, 维度 B job 照常成功 (FR-S03)', async () => {
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
    // 删 eod_bar 维度行 → A job loadDimension 顶层 throw (确定性失败注入)。
    await prisma.syncDimension.delete({ where: { dimensionKey: 'eod_bar' } });
    try {
      const jobA = await queue.enqueueDimensionJob(
        { dimensionKey: 'eod_bar', mode: 'delta', asOf: AS_OF, triggeredBy: 'cli' },
        { retryMax: 1, lane: 'default' },
      );
      const jobB = await queue.enqueueDimensionJob(
        { dimensionKey: 'universe', mode: 'delta', asOf: AS_OF, triggeredBy: 'cli' },
        { retryMax: 1, lane: 'default' },
      );
      await expect(jobA.waitUntilFinished(events, 30_000)).rejects.toThrow(/不存在/);
      await jobB.waitUntilFinished(events, 30_000); // B 不受 A 失败影响 (无连坐)。
      expect(await prisma.instrument.count()).toBeGreaterThan(0);
      const runB = await prisma.syncRun.findFirst({ where: { syncType: 'sync:universe' } });
      expect(runB?.status).toBe('success');
      const runA = await prisma.syncRun.findFirst({ where: { syncType: 'sync:eod_bar' } });
      expect(runA?.status).toBe('failed');
    } finally {
      await prisma.syncDimension.create({
        data: {
          dimensionKey: 'eod_bar',
          cronExpr: '0 0 22 * * *',
          vendor: 'lixinger',
          marketScope: ['cn'],
          adjustTypes: ['none', 'forward', 'backward'],
          batchSize: 1,
          priority: 8,
        },
      });
      await worker.onModuleDestroy();
      await events.close();
      await queue.onModuleDestroy();
    }
  });

  it('⑥ retryMax 耗尽 → QueueEvents failed 告警 (结构化 ERROR) + 每 attempt 一行 SyncRun=failed', async () => {
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
    const errorSpy = vi.spyOn(Logger.prototype, 'error');
    await prisma.syncDimension.delete({ where: { dimensionKey: 'eod_bar' } });
    try {
      // 直接 add 绕过 helper 的 60s 指数退避 (attempts 注入语义已在 ① 断言) — 快速耗尽。
      const job = await queue.queue.add(
        'sync:eod_bar',
        { dimensionKey: 'eod_bar', mode: 'delta', asOf: AS_OF, triggeredBy: 'tick' },
        { attempts: 2, backoff: { type: 'fixed', delay: 50 } },
      );
      await expect(job.waitUntilFinished(events, 30_000)).rejects.toThrow(/不存在/);

      // 每 attempt 各开收一行 per-dim SyncRun=failed (running 不悬挂)。
      const runs = await prisma.syncRun.findMany({ where: { syncType: 'sync:eod_bar' } });
      expect(runs).toHaveLength(2);
      expect(runs.every((r) => r.status === 'failed')).toBe(true);

      // retry 耗尽 → worker QueueEvents failed 监听已发结构化 ERROR (轮询等异步监听落地)。
      await vi.waitFor(() => {
        const hit = errorSpy.mock.calls.some(
          (c) => typeof c[0] === 'string' && c[0].includes('retries exhausted'),
        );
        expect(hit).toBe(true);
      });
    } finally {
      errorSpy.mockRestore();
      await prisma.syncDimension.create({
        data: {
          dimensionKey: 'eod_bar',
          cronExpr: '0 0 22 * * *',
          vendor: 'lixinger',
          marketScope: ['cn'],
          adjustTypes: ['none', 'forward', 'backward'],
          batchSize: 1,
          priority: 8,
        },
      });
      await worker.onModuleDestroy();
      await events.close();
      await queue.onModuleDestroy();
    }
  });

  it('⑦ fact job 前置重算 (018 T002): seed watchlist → eod_bar job → 命中标的 syncTier=0 + DailyBar 落库', async () => {
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
      // 先种 universe (mock 3 标的), 再 seed 自选 600519。
      const uJob = await queue.enqueueDimensionJob(
        { dimensionKey: 'universe', mode: 'delta', asOf: '2026-06-01', triggeredBy: 'cli' },
        { retryMax: 1, lane: 'default' },
      );
      await uJob.waitUntilFinished(events, 30_000);
      const group = await prisma.group.create({
        data: { accountId: 1001n, name: '自选', type: 'custom', order: 0 },
      });
      await prisma.watchlistItem.create({
        data: { groupId: group.id, market: 'cn', code: '600519', order: 0 },
      });

      const job = await queue.enqueueDimensionJob(
        { dimensionKey: 'eod_bar', mode: 'delta', asOf: '2026-06-01', triggeredBy: 'cli' },
        { retryMax: 1, lane: 'default' },
      );
      await job.waitUntilFinished(events, 30_000);

      // 全路径自带重算证据: 命中标的升 T0, 其余维持 T2; 维度同步本身照常落库。
      const hit = await prisma.instrument.findUniqueOrThrow({
        where: { market_code: { market: 'cn', code: '600519' } },
      });
      expect(hit.syncTier).toBe(0);
      const others = await prisma.instrument.findMany({ where: { code: { not: '600519' } } });
      expect(others.length).toBeGreaterThan(0);
      expect(others.every((i) => i.syncTier === 2)).toBe(true);
      expect(await prisma.dailyBar.count()).toBeGreaterThan(0);
    } finally {
      await worker.onModuleDestroy();
      await events.close();
      await queue.onModuleDestroy();
    }
  });

  it('⑧ universe job 不触发重算 (018 T002: 仅 fact 维度前置)', async () => {
    const queue = new MarketdataSyncQueue(lifecycle.client, CFG);
    const tierRecalc = new SyncTierRecalc(prisma);
    const recalcSpy = vi.spyOn(tierRecalc, 'recalcSafely');
    const worker = new MarketdataSyncWorker(
      lifecycle.client,
      buildRegistry(tierRecalc),
      queue,
      coldStartUnused(),
      CFG,
      new SyncRunRecorder(prisma),
    );
    const events = new QueueEvents(MARKETDATA_SYNC_QUEUE, { connection: lifecycle.client });
    await events.waitUntilReady();
    worker.onModuleInit();
    try {
      const job = await queue.enqueueDimensionJob(
        { dimensionKey: 'universe', mode: 'delta', asOf: AS_OF, triggeredBy: 'cli' },
        { retryMax: 1, lane: 'default' },
      );
      await job.waitUntilFinished(events, 30_000);
      expect(await prisma.instrument.count()).toBeGreaterThan(0); // universe 本身照常。
      expect(recalcSpy).not.toHaveBeenCalled();
    } finally {
      await worker.onModuleDestroy();
      await events.close();
      await queue.onModuleDestroy();
    }
  });

  it('③ name/payload 漂移 job → processor 拒 (不路由错维度)', async () => {
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
      // 绕过 helper 直接 add 错名 job (attempts=1 不重试, 快速到终态)。
      const job = await queue.queue.add(
        'sync:profile',
        { dimensionKey: 'universe', mode: 'delta', asOf: AS_OF, triggeredBy: 'cli' },
        { attempts: 1 },
      );
      await expect(job.waitUntilFinished(events, 30_000)).rejects.toThrow(/不一致/);
      expect(await prisma.syncRun.count()).toBe(0); // 未进 executor, 零审计行。
    } finally {
      await worker.onModuleDestroy();
      await events.close();
      await queue.onModuleDestroy();
    }
  });
});
