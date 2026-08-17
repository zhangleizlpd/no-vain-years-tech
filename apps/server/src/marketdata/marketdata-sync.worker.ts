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
import { DimensionExecutorRegistry } from './dimension-executor.js';
import { MARKETDATA_QUEUE_REDIS } from './marketdata-queue-connection.js';
import {
  MARKETDATA_SYNC_QUEUE,
  MARKETDATA_WORKER_DISABLED,
  MarketdataSyncQueue,
  dimensionJobName,
  type DimensionJobPayload,
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

/**
 * 维度 worker (017 T009, ADR-0049 执行层): 裸 `new Worker` 消费 `marketdata-sync` queue,
 * 按 job.name (`sync:<dim>`) 路由 `DimensionExecutorRegistry` per-dim 路径 (自管
 * `sync:<dim>` SyncRun + bullJobId)。失败隔离: 单维度 job 失败只影响自身 attempts,
 * sibling job 不连坐 (FR-S03)。
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
  private worker?: Worker<DimensionJobPayload>;
  private events?: QueueEvents;

  constructor(
    @Inject(MARKETDATA_QUEUE_REDIS) private readonly connection: Redis,
    private readonly executors: DimensionExecutorRegistry,
    private readonly syncQueue: MarketdataSyncQueue,
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
    this.worker = new Worker<DimensionJobPayload>(
      MARKETDATA_SYNC_QUEUE,
      (job) => this.process(job),
      { connection: this.connection, concurrency: 1 },
    );
    this.events = new QueueEvents(MARKETDATA_SYNC_QUEUE, { connection: this.connection });
    // retry 耗尽硬失败 (与 executor 内业务降级告警分工两道)。
    this.events.on('failed', ({ jobId, failedReason }) => {
      this.logger.error(
        `marketdata-sync job failed (retries exhausted): ${JSON.stringify({ jobId, failedReason })}`,
      );
    });
  }

  /** processor: job.name `sync:<dim>` 路由 executor per-dim 路径。 */
  async process(job: Job<DimensionJobPayload>): Promise<SyncRunStats> {
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
