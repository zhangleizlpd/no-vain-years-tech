import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { QueueEvents } from 'bullmq';
import { coldStartUnused } from '../_support/cold-start-stub';
import { syncRunRecorderNoop } from '../_support/sync-run-recorder-stub';
import { QueueRedisLifecycle } from '../../src/marketdata/marketdata-queue-connection';
import {
  ANCHOR_COLD_START_JOB,
  MARKETDATA_SYNC_QUEUE,
  MARKETDATA_WORKER_DISABLED,
  MarketdataSyncQueue,
  dimensionJobName,
  type DimensionJobPayload,
} from '../../src/marketdata/marketdata-sync.queue';
import { MarketdataSyncWorker } from '../../src/marketdata/marketdata-sync.worker';
import type {
  DimensionExecutorRegistry,
  DimensionKey,
} from '../../src/marketdata/dimension-executor';
import type { MarketdataSyncConfig } from '../../src/config/marketdata.config';

// 066 T11 港股与美股链发现串行、不争配额 (FR-015, SC-009, spec state_branches 20; plan §A10/§A12)。
//
// ## 为什么必须是**真 Redis + 真 worker**
//
// 被测的不是一段业务逻辑, 是**队列拓扑**: 「两类 job 在同一条队列上」+「worker concurrency=1」
// 这两件事合起来才等于「不可能并发」。两者都写在 BullMQ 的 job / worker 上, 不在任何被测函数
// 的返回值里 —— 拿 mock 队列断言等于自证。而拆队列 / 把 concurrency 调到 2 的那一刻并发就回来
// 了 (港美两轮同时打同一个 vendor 的 10 发/30 秒桶), **不会有任何单测红**。
//
// ⚠️ 「错峰 cron」保证不了不争: 冷启动是全系统唯一的非 cron 触发者, 建锚时刻由人决定。
// 单队列串行才是真保证 —— 冷启动自己也是这条队列上的一个 job (`sync:anchor-cold-start`),
// 这正是 ① 把它一并入队来断的原因 (issue #159 后冷启动不再往队列投 child, 但它自己仍在队上)。
//
// ## 只要 Redis, **不要 PG**
//
// 本文件不碰任何表: worker 的维度支路只调 `DimensionExecutorRegistry.execute`, 这里用一个
// 记录执行窗的替身顶掉 (真执行器要打 vendor, 那是另一片的地盘)。⇒ 按 `_support/isolated-db.ts`
// 的入口表, Redis-only 场景**自起 RedisContainer**, 走 `setupIsolatedStores()` 会白克隆一份 PG。
//
// 🚨 链请求参数「永远只传 code/start/end/option_type」那条 (verify ③) 是**采集端**的事,
// 钉在 `src/marketdata/futu-option-chain.adapter.spec.ts` (Small, 零外部依赖)。
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

/** 港股链 / 美股链两个维度的 job payload (形态照 tick 自动入队)。 */
const payloadOf = (dimensionKey: DimensionKey): DimensionJobPayload => ({
  dimensionKey,
  mode: 'delta',
  asOf: '2026-08-21',
  triggeredBy: 'tick',
});

/** 单个执行器的一次执行 (慢 250ms) —— 并发窗靠它张开, 串行时 `maxActive` 恒为 1。 */
const EXEC_MS = 250;

describe('066 T11 港股与美股链发现串行 (Testcontainers Redis, 真 worker)', () => {
  let container: StartedRedisContainer;
  let lifecycle: QueueRedisLifecycle;
  let queue: MarketdataSyncQueue;
  let events: QueueEvents;

  beforeAll(async () => {
    container = await new RedisContainer('redis:7-alpine').start();
    lifecycle = new QueueRedisLifecycle(container.getConnectionUrl());
    events = new QueueEvents(MARKETDATA_SYNC_QUEUE, { connection: lifecycle.client });
    await events.waitUntilReady();
    // 🚨 sentinel 若被别的用例/环境留着, worker 静默不启动 ⇒ ② 会等到超时而不是绿。
    delete process.env[MARKETDATA_WORKER_DISABLED];
  }, 120_000);

  afterAll(async () => {
    await events?.close();
    lifecycle?.onApplicationShutdown();
    await container?.stop();
  });

  beforeEach(async () => {
    queue = new MarketdataSyncQueue(lifecycle.client, CFG);
    await queue.queue.obliterate({ force: true });
  });

  it('① 港股链与美股链两个维度 job 入的是**同一条队列** (concurrency=1 串行的前提)', async () => {
    await queue.enqueueDimensionJob(payloadOf('option_contract'), { retryMax: 3 });
    await queue.enqueueDimensionJob(payloadOf('hk_option_contract'), { retryMax: 3 });
    // 冷启动是全系统唯一的非 cron 触发者 —— 它也在这条队列上, 串行保证才覆盖得到它。
    await queue.enqueueColdStart({ anchorId: '1', ticker: 'hk:00700' });

    const jobs = await queue.queue.getJobs(['waiting', 'delayed', 'prioritized']);

    expect(jobs.map((j) => j.name).sort()).toEqual(
      [
        ANCHOR_COLD_START_JOB,
        dimensionJobName('option_contract'),
        dimensionJobName('hk_option_contract'),
      ].sort(),
    );
    // 🚨 给港股链另起一条队列的那一刻并发就回来了, 且不会有任何单测红。本层验的正是这个前提。
    expect(new Set(jobs.map((j) => j.queueQualifiedName)).size).toBe(1);
  });

  it('② 港美两轮**同时入队** → 串行完成、零并发窗、无一方失败 (SC-009, state_branches 20)', async () => {
    let active = 0;
    let maxActive = 0;
    const ran: DimensionKey[] = [];
    const registry = {
      execute: async (dimensionKey: DimensionKey) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        ran.push(dimensionKey);
        await new Promise((r) => setTimeout(r, EXEC_MS));
        active -= 1;
        return {
          budgetExhausted: false,
          stats: { scanned: 0, ok: 0, skipped: 0, failed: 0, findings: [] },
        };
      },
    } as unknown as DimensionExecutorRegistry;

    const worker = new MarketdataSyncWorker(
      lifecycle.client,
      registry,
      queue,
      coldStartUnused(),
      CFG,
      // #165 起构造器第 6 位。本 IT 无 PG ⇒ 走 no-op 桩（返 0 = 无僵尸行可收，正是稳态）。
      // 🚨 它刻意**不抛**（与 `coldStartUnused()` 不同）—— 理由见桩自身的注释：
      //    ① 它在正常路径上就会被调（每个维度 job 开工前一次）；② 调用点外面有 try/catch，
      //    抛了会被吞成 WARN、测试照样绿。
      syncRunRecorderNoop(),
    );

    const [usJob, hkJob] = await Promise.all([
      queue.enqueueDimensionJob(payloadOf('option_contract'), { retryMax: 3 }),
      queue.enqueueDimensionJob(payloadOf('hk_option_contract'), { retryMax: 3 }),
    ]);
    worker.onModuleInit();
    try {
      await Promise.all([
        usJob.waitUntilFinished(events, 30_000),
        hkJob.waitUntilFinished(events, 30_000),
      ]);

      // 🚨 本条的全部意义: 任意时刻至多一个执行器在跑 ⇒ 港美两轮**结构上**不可能同时打
      //    vendor 那个 10 发/30 秒的桶。两者是相加的墙钟, 不是取最大。
      expect(maxActive).toBe(1);
      expect(ran.sort()).toEqual(['hk_option_contract', 'option_contract']);
      // 「无一方因配额耗尽而失败」的两个面: 失败 job 为零, 且没有任何顺延重入队的 delayed job
      // (`budgetExhausted` 的表现就是后者 —— 只看失败数会把顺延当成成功放过去)。
      expect(await queue.queue.getFailedCount()).toBe(0);
      expect(await queue.queue.getDelayedCount()).toBe(0);
      expect(await queue.queue.getCompletedCount()).toBe(2);
    } finally {
      await worker.onModuleDestroy();
    }
  });
});
