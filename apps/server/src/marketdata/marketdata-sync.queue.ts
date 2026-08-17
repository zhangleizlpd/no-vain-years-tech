import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import {
  FlowProducer,
  Queue,
  type FlowJob,
  type Job,
  type JobNode,
  type JobsOptions,
} from 'bullmq';
import type { Redis } from 'ioredis';
import { marketdataSyncConfig, type MarketdataSyncConfig } from '../config/marketdata.config.js';
import type { DimensionKey, SyncMode } from './dimension-executor.js';
import { MARKETDATA_QUEUE_REDIS } from './marketdata-queue-connection.js';
import { closeWithTimeout } from '../security/close-with-timeout.js';

/**
 * `marketdata-sync` 队列的**生产者面** —— 队列名 / job 名 / payload 契约 + 入队 helper。
 *
 * 🚨 **与消费者面 (`marketdata-sync.worker.ts` 的 `MarketdataSyncWorker`) 分文件, 是结构约束
 * 不是整理癖。** 两者同文件时, 任何「被 worker 路由、自己又要入队」的 use case 都会与该文件
 * 形成**循环 file import**: use case 把 `MarketdataSyncQueue` 当构造器参数类型 ⇒
 * `emitDecoratorMetadata` 在**类装饰期**就要读它 ⇒ 后加载的一侧拿到 TDZ ⇒
 * `ReferenceError: Cannot access 'MarketdataSyncQueue' before initialization`, **boot 直接炸**
 * 而不是某个测试红。060 的锚冷启动 (worker 路由它 + 它要组 flow 入队) 是第一个撞上的。
 *
 * 修法取的是业内通行解而非 `forwardRef`: NestJS 官方文档把 `forwardRef` 的代价写在明面上
 * ——「互相依赖的 provider 实例化顺序变得不确定」; Trilon 的定性是「last resort … shouldn't
 * be used as a catch all」, 推荐的是把共享部分抽成独立单元。队列场景的通行做法本就是
 * **生产者与消费者分属不同单元、彼此无反向依赖**。官方 FAQ 另有一条正中此处:
 * 「For constants, it is advised to create a separate file to avoid circular dependencies」。
 *
 * ⚠️ 因此: **本文件 MUST NOT import `marketdata-sync.worker.js`**, 也 MUST NOT import 任何
 * 会被 worker 路由的 use case —— 依赖方向恒为「消费者 → 生产者」单向。
 */

/** 单 queue 承载全部维度 named job (`sync:<dim>`), concurrency=1 串行天然限频。 */
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
  /**
   * 触发源审计: tick 自动 / cli 手动 / cascade 级联 / requeue 配额顺延 /
   * anchor-cold-start 锚首建冷启动 (060)。
   *
   * ⚠️ **纯审计, 无人对它分支** —— 加值不改行为, 但别把它当开关用。
   */
  triggeredBy: 'tick' | 'cli' | 'cascade' | 'requeue' | 'anchor-cold-start';
}

/** named job 形态: `sync:<dim>` (worker 路由键 + SyncRun.syncType 同形)。 */
export function dimensionJobName(key: DimensionKey): string {
  return `sync:${key}`;
}

/**
 * 锚首建冷启动 job (060 plan §D3)。**走同一条 `marketdata-sync` 队列** —— 另起队列 =
 * 冷启动与夜间批并发打 vendor, 直接撞限频; 那条 `concurrency=1` 是限频的支柱 (FR-017 / SC-004)。
 */
export const ANCHOR_COLD_START_JOB = 'sync:anchor-cold-start';

/**
 * 冷启动 job 的**自有** payload —— 与 {@link DimensionJobPayload} 无继承无共用
 * (🚫 那边一个字段都不加: 给「工作集选择」开第二个口子正是 `anchor-driven-sync-gate.ts`
 * 那条绊线注释警告的形态)。
 */
export interface AnchorColdStartJobPayload {
  ticker: string;
  /** `Anchor.id`。BigInt 过不了 job payload 的 JSON 序列化, 故走字符串。 */
  anchorId: string;
  /**
   * 缺省 = **第一相**(定日历 → seed → 开闸 → 复判 → 组 flow 入队链/日线);
   * `'snapshot'` = **第二相**, 由第一相组的 flow 以 **parent** 身份挂在链/日线两个 child 之上。
   *
   * 🚨 两相是**必须**的, 不是优化: worker `concurrency=1` 且冷启动 job 自己就跑在这条 worker
   * 上 ⇒ 它入队的 flow 在它返回之前一个都跑不了。若在同一次调用里 inline 抓快照, 对一只全新
   * 锚 `option_contract` 恰好 0 行 ⇒ `SyncOptionSnapshotUseCase` 判「无未到期合约」直接
   * WARN + 零外呼返回 ⇒ **目标交易日的快照永远不写, 而整条路径全绿**。SC-001 要的正是那份快照。
   */
  phase?: 'snapshot';
}

/**
 * 冷启动 job 的 `attempts` —— 取 `SyncDimension.retryMax` 的 schema 默认值 (3) 同档。
 * 冷启动没有自己的 `sync_dimension` 行 (它不是维度), 故取常量而非查表。
 */
export const ANCHOR_COLD_START_RETRY_MAX = 3;

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
