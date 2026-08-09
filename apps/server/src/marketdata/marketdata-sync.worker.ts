import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  FlowProducer,
  Queue,
  QueueEvents,
  Worker,
  type FlowJob,
  type Job,
  type JobNode,
  type JobsOptions,
} from 'bullmq';
import type { Redis } from 'ioredis';
import { marketdataSyncConfig, type MarketdataSyncConfig } from '../config/marketdata.config.js';
import {
  DimensionExecutorRegistry,
  type DimensionKey,
  type SyncMode,
} from './dimension-executor.js';
import { MARKETDATA_QUEUE_REDIS } from './marketdata-queue-connection.js';
import type { SyncRunStats } from './sync-run.recorder.js';
import { closeWithTimeout } from '../security/close-with-timeout.js';

/** 单 queue 承载全部 6 维度 named job (`sync:<dim>`), concurrency=1 串行天然限频。 */
export const MARKETDATA_SYNC_QUEUE = 'marketdata-sync';

/** CLI 永不起 worker 的 sentinel env (017 D6, clarify Q2): entry 起手置位 → boot no-op。 */
export const MARKETDATA_WORKER_DISABLED = 'MARKETDATA_WORKER_DISABLED';

/** 维度 job payload (named job `sync:<dim>` 携带; asOf 字符串形态跨进程稳定)。 */
export interface DimensionJobPayload {
  dimensionKey: DimensionKey;
  mode: SyncMode;
  /** 目标日 YYYY-MM-DD。 */
  asOf: string;
  backfillHistoryDays?: number;
  maxEodInstruments?: number;
  /** backfill 市场范围缩窄 (038 seam#3, CLI `--markets` 透传 → executor 工作集交集)。 */
  markets?: string[];
  /** backfill force-refetch (CLI `--no-skip-complete` 透传 → 绕过 fundamental skip-complete 游标)。 */
  noSkipComplete?: boolean;
  /** 触发源审计: tick 自动 / cli 手动 / cascade 级联 / requeue 配额顺延。 */
  triggeredBy: 'tick' | 'cli' | 'cascade' | 'requeue';
}

/** named job 形态: `sync:<dim>` (worker 路由键 + SyncRun.syncType 同形)。 */
export function dimensionJobName(key: DimensionKey): string {
  return `sync:${key}`;
}

/**
 * 队列入队面 (017 T009): Queue 实例 + `enqueueDimensionJob` helper。
 *
 * job opts 统一在此注入 (tick / trigger CLI / backfill CLI / 顺延 re-enqueue 共用):
 * `attempts = SyncDimension.retryMax` + 指数退避 60s 起 (D4, vendor 限频场景下密集重试
 * 只会再撞) + removeOnComplete/removeOnFail 留存上限走 config (FR-S12 内存有界)。
 */
@Injectable()
export class MarketdataSyncQueue implements OnModuleDestroy {
  readonly queue: Queue;
  private flowProducer?: FlowProducer;

  constructor(
    @Inject(MARKETDATA_QUEUE_REDIS) private readonly connection: Redis,
    @Inject(marketdataSyncConfig.KEY) private readonly cfg: MarketdataSyncConfig,
  ) {
    this.queue = new Queue(MARKETDATA_SYNC_QUEUE, { connection });
  }

  /** 入队单维度 job。`retryMax` 来自 SyncDimension 行 (调用方已载); `delayMs` 供顺延。 */
  async enqueueDimensionJob(
    payload: DimensionJobPayload,
    opts: { retryMax: number; delayMs?: number },
  ): Promise<Job<DimensionJobPayload>> {
    return this.queue.add(dimensionJobName(payload.dimensionKey), payload, this.jobOpts(opts));
  }

  /** job opts 装配 (FlowProducer 组树时复用同语义, T014)。 */
  jobOpts(opts: { retryMax: number; delayMs?: number }): JobsOptions {
    return {
      attempts: opts.retryMax,
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: { count: this.cfg.removeOnCompleteCount },
      removeOnFail: { count: this.cfg.removeOnFailCount },
      ...(opts.delayMs !== undefined ? { delay: opts.delayMs } : {}),
    };
  }

  /** flow 树入队 (T014 tick / T017 cascade CLI 共用; lazy 建 FlowProducer 共享队列连接)。 */
  async enqueueFlow(tree: FlowJob): Promise<JobNode> {
    this.flowProducer ??= new FlowProducer({ connection: this.connection });
    return this.flowProducer.add(tree);
  }

  async onModuleDestroy(): Promise<void> {
    await closeWithTimeout('marketdata-sync flowProducer', async () => this.flowProducer?.close());
    await closeWithTimeout('marketdata-sync queue', () => this.queue.close());
  }
}

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
