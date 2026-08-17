import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { QueueEvents, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { marketdataSyncConfig, type MarketdataSyncConfig } from '../config/marketdata.config.js';
import { AnchorColdStartUseCase, type ColdStartResult } from './anchor-cold-start.usecase.js';
import { DimensionExecutorRegistry } from './dimension-executor.js';
import { MARKETDATA_QUEUE_REDIS } from './marketdata-queue-connection.js';
import {
  ANCHOR_COLD_START_JOB,
  ANCHOR_COLD_START_RETRY_MAX,
  MARKETDATA_SYNC_QUEUE,
  MARKETDATA_WORKER_DISABLED,
  MarketdataSyncQueue,
  dimensionJobName,
  type AnchorColdStartJobPayload,
  type DimensionJobPayload,
  type MarketdataSyncJobPayload,
} from './marketdata-sync.queue.js';
import type { SyncRunStats } from './sync-run.recorder.js';
import { closeWithTimeout } from '../security/close-with-timeout.js';

/**
 * `marketdata-sync` 队列的**消费者面**。生产者面 (队列名 / job 名 / payload 契约 / 入队
 * helper) 住 `marketdata-sync.queue.ts` —— 依赖方向恒为「消费者 → 生产者」单向。
 *
 * 🚨 **别把生产者搬回来。** 两者同文件时, 任何「被本 worker 路由、自己又要入队」的 use case
 * 都会与本文件形成循环 file import, 而它的表现是 boot 期
 * `ReferenceError: Cannot access 'MarketdataSyncQueue' before initialization` ——
 * 不是某个测试红。判据与业内解见 `marketdata-sync.queue.ts` 文件头。
 */

/** 路由谓词: `job.name` 是唯一路由键 (与维度分支同源, payload 形态只是它的推论)。 */
function isColdStartJob(job: Job<MarketdataSyncJobPayload>): job is Job<AnchorColdStartJobPayload> {
  return job.name === ANCHOR_COLD_START_JOB;
}

/**
 * 维度 worker (017 T009, ADR-0049 执行层): 裸 `new Worker` 消费 `marketdata-sync` queue,
 * 按 job.name (`sync:<dim>`) 路由 `DimensionExecutorRegistry` per-dim 路径 (自管
 * `sync:<dim>` SyncRun + bullJobId)。失败隔离: 单维度 job 失败只影响自身 attempts,
 * sibling job 不连坐 (FR-S03)。
 *
 * 060 起本队列**多一条路由**: `sync:anchor-cold-start` → `AnchorColdStartUseCase`,
 * 它**不**进 `DimensionExecutorRegistry` (冷启动不是维度, 没有 `sync_dimension` 行)。
 * 复用同一条队列是硬约束而非省事: 另起队列 = 冷启动与夜间批并发打 vendor (plan §D3)。
 *
 * 告警分工两道: executor 内业务降级告警 (failedTargets 阈值, per-dim) / 本类 QueueEvents
 * `failed` 监听 = retry 耗尽硬失败 (结构化 ERROR log, FR-S17 log-based alerting 出口)。
 *
 * 启停门 (D6): `MARKETDATA_WORKER_DISABLED` sentinel 置位 → onModuleInit no-op (CLI 进程
 * 只入队不消费, clarify Q2); OnModuleDestroy close 全对象 (镜像 QueueRedisLifecycle 对称)。
 */
@Injectable()
export class MarketdataSyncWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MarketdataSyncWorker.name);
  private worker?: Worker<MarketdataSyncJobPayload>;
  private events?: QueueEvents;

  constructor(
    @Inject(MARKETDATA_QUEUE_REDIS) private readonly connection: Redis,
    private readonly executors: DimensionExecutorRegistry,
    private readonly syncQueue: MarketdataSyncQueue,
    private readonly coldStart: AnchorColdStartUseCase,
    @Inject(marketdataSyncConfig.KEY) private readonly cfg: MarketdataSyncConfig,
  ) {}

  /** worker 是否已启动 (sentinel 断言面 + 测试观察点)。 */
  get running(): boolean {
    return this.worker !== undefined;
  }

  onModuleInit(): void {
    if (process.env[MARKETDATA_WORKER_DISABLED]) {
      this.logger.log(`${MARKETDATA_WORKER_DISABLED} 置位 — worker 不启动 (CLI 入队进程, D6)`);
      return;
    }
    this.worker = new Worker<MarketdataSyncJobPayload>(
      MARKETDATA_SYNC_QUEUE,
      (job) => this.process(job),
      { connection: this.connection, concurrency: 1 },
    );
    this.events = new QueueEvents(MARKETDATA_SYNC_QUEUE, { connection: this.connection });
    // retry 耗尽硬失败 (与 executor 内业务降级告警分工两道)。
    this.events.on('failed', ({ jobId, failedReason }) => {
      void this.onJobFailed(jobId, failedReason);
    });
  }

  /**
   * `QueueEvents('failed')` 出口 = **retry 耗尽**, 不是每次 attempt 失败 —— bullmq 的
   * `Job.moveToFailed` 只在 `shouldRetryJob` 为假时才走 `moveToFinished(target='failed')`
   * (发本事件的那一条); 还能重试的走 `moveToDelayed`/`retryJob`, 发的是 `delayed`/`waiting`。
   *
   * 两件事: ① 结构化 ERROR log (FR-S17 log-based alerting 唯一出口, 既有);
   * ② 冷启动 job 另补一笔 `retry_exhausted` 运行记录 (FR-019a) —— 维度 job **不**碰那张表。
   *
   * 🚨 **本方法不许抛**: 它挂在事件监听上, 抛出去就是 unhandled rejection (进程级噪音,
   * 且吞不掉的那一刻正是 Redis / DB 已经不健康的时候)。落库失败降级成 WARN。
   */
  async onJobFailed(jobId: string, failedReason: string): Promise<void> {
    this.logger.error(
      `marketdata-sync job failed (retries exhausted): ${JSON.stringify({ jobId, failedReason })}`,
    );
    try {
      const job = await this.syncQueue.queue.getJob(jobId);
      // undefined = 已被 removeOnFail 留存上限挤掉 (FR-S12 内存有界的代价), 无从判断 job 类型。
      if (job === undefined || job.name !== ANCHOR_COLD_START_JOB) return;
      const { ticker, anchorId } = job.data as AnchorColdStartJobPayload;
      await this.coldStart.recordRetryExhausted({
        anchorId: BigInt(anchorId),
        ticker,
        now: new Date(),
        failedReason,
      });
    } catch (err) {
      this.logger.warn(
        `[anchor-cold-start] retry 耗尽运行记录落库失败 (jobId=${jobId}): ${String(err)}`,
      );
    }
  }

  /** processor: `job.name` 路由 —— `sync:anchor-cold-start` 走冷启动, 其余 `sync:<dim>` 走 executor。 */
  async process(job: Job<MarketdataSyncJobPayload>): Promise<SyncRunStats | ColdStartResult> {
    if (isColdStartJob(job)) return this.processColdStart(job);
    return this.processDimension(job as Job<DimensionJobPayload>);
  }

  /**
   * 冷启动分支 (060 plan §D3)。**不**进 `DimensionExecutorRegistry` —— 冷启动没有
   * `sync_dimension` 行, 也不该有 (它是事件驱动的一次性补数, 不是有水位的周期维度)。
   *
   * 顺延语义与维度分支逐字同源: `vendor_budget` ⇒ 延时重入队**同 payload** (含 `phase`),
   * deferral ≠ failure 故不耗本 job attempts (FR-019b)。`awaiting_chain` 无需重投 ——
   * 第二相是 flow parent, 由 BullMQ 的「children 全终态才跑」保证。
   */
  private async processColdStart(job: Job<AnchorColdStartJobPayload>): Promise<ColdStartResult> {
    const { ticker, anchorId, phase } = job.data;
    if (typeof ticker !== 'string' || ticker === '' || !/^\d+$/.test(String(anchorId))) {
      // 非法 payload (生产者漂移) → 直接 fail, 与维度分支的 name/dimensionKey 校验同一形态。
      throw new Error(`${ANCHOR_COLD_START_JOB} payload 非法: ${JSON.stringify(job.data)}`);
    }
    const result = await this.coldStart.run({
      anchorId: BigInt(anchorId),
      ticker,
      now: new Date(),
      phase,
    });
    if (!result.settled && result.deferral === 'vendor_budget') {
      await this.syncQueue.enqueueColdStart(job.data, {
        retryMax: job.opts.attempts ?? ANCHOR_COLD_START_RETRY_MAX,
        delayMs: this.cfg.requeueDelayMs,
      });
      this.logger.log(
        `${ANCHOR_COLD_START_JOB} 配额耗尽 — 顺延 re-enqueue (delay=${this.cfg.requeueDelayMs}ms, ticker=${ticker})`,
      );
    }
    return result;
  }

  /** 维度分支 (017 T009 原语义, 逐字不变): job.name `sync:<dim>` 路由 executor per-dim 路径。 */
  private async processDimension(job: Job<DimensionJobPayload>): Promise<SyncRunStats> {
    const {
      dimensionKey,
      mode,
      asOf,
      backfillHistoryDays,
      maxEodInstruments,
      markets,
      noSkipComplete,
    } = job.data;
    if (job.name !== dimensionJobName(dimensionKey)) {
      // 非法 payload (name/payload 漂移) → 直接 fail (不路由错维度)。
      throw new Error(`job name "${job.name}" 与 payload dimensionKey "${dimensionKey}" 不一致`);
    }
    const result = await this.executors.execute(
      dimensionKey,
      {
        mode,
        asOf,
        now: new Date(),
        backfillHistoryDays,
        maxEodInstruments,
        markets,
        noSkipComplete,
      },
      job.id,
    );
    if (result.budgetExhausted) {
      // 配额顺延 (D5): standalone delayed job 重入队同 named job — 不进 flow、payload
      // 原样 (triggeredBy/配额参数保留)、deferral ≠ failure 不耗本 job attempts。
      await this.syncQueue.enqueueDimensionJob(job.data, {
        retryMax: job.opts.attempts ?? 1,
        delayMs: this.cfg.requeueDelayMs,
      });
      this.logger.log(
        `sync:${dimensionKey} 配额耗尽 — 顺延 re-enqueue (delay=${this.cfg.requeueDelayMs}ms, skipped=${result.stats.skipped})`,
      );
    }
    return result.stats;
  }

  async onModuleDestroy(): Promise<void> {
    await closeWithTimeout('marketdata-sync worker', async () => this.worker?.close());
    await closeWithTimeout('marketdata-sync events', async () => this.events?.close());
  }
}
