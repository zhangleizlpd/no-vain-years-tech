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
 * 📌 issue #159 后冷启动**已不再入队** (链与快照都改直调本体), 故它本身不再构成这条环 ——
 *    但本约束对**任何**「被 worker 路由、自己又要入队」的 use case 仍然成立, 别据此放松。
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
   * ⚠️ **无人对它分支** —— 加值不改行为, 别把它当开关用。
   * 🚨 但它**不再只是日志**: #202 起随 `SyncRun.triggered_by` 落库, 是「连续 N 轮」判据里
   *   「哪些行算一轮」的唯一依据 (只有 `tick` 算)。⇒ **新增入队路径必须诚实地报自己是谁**,
   *   随手填 `'tick'` 会让那一轮被计数器当成「按计划执行过了」。
   */
  triggeredBy: DimensionTriggeredBy;
}

/**
 * 维度 job 的触发源值域 —— 同时是 `SyncRun.triggered_by` 的值域单一来源 (#202)。
 *
 * 🚨 `anchor-cold-start` **不产出 `sync_run` 行**: 冷启动是另一条 job 路由
 * ({@link ANCHOR_COLD_START_JOB}), 直调采集本体 (#159 后两相合一), 全程不开 SyncRun 行。
 * 它留在本值域里是因为**这是 job 的触发源值域**, 不是「库里见得到的值」的清单。
 */
export type DimensionTriggeredBy = 'tick' | 'cli' | 'cascade' | 'requeue' | 'anchor-cold-start';

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
 * 冷启动 job 的**自有** payload —— 与 {@link DimensionJobPayload} 无继承无共用。
 *
 * 🚫 **那边一个字段都不加**: 给「工作集选择」开第二个口子正是 `anchor-driven-sync-gate.ts`
 * 那条绊线注释警告的形态 —— 工作集会有两套口径, 且**漂了不报错**。
 *
 * ⚠️ **这条禁令的射程仅限本 payload, 不及于「直调采集本体」** (issue #159 澄清): 采集本体
 * (`SyncOptionContractUseCase.collect` / `SyncOptionSnapshotUseCase.collect`) 收一个标的
 * 数组参数**不新增任何口径** —— 选择权仍恒属 `DimensionExecutorRegistry.factExecutor` 的
 * `loadActiveInstruments`, 本体从不自己查库。排查 #159 时曾把这条禁令误当成解空间边界,
 * 进而提出「给全域重扫加游标缓存」那种打补丁的解法; 教训固化在
 * `.claude/rules/server-impl-playbook.md` § 改结构三步。
 */
export interface AnchorColdStartJobPayload {
  ticker: string;
  /** `Anchor.id`。BigInt 过不了 job payload 的 JSON 序列化, 故走字符串。 */
  anchorId: string;
}

/**
 * 冷启动 job 的 `attempts` —— 取 `SyncDimension.retryMax` 的 schema 默认值 (3) 同档。
 * 冷启动没有自己的 `sync_dimension` 行 (它不是维度), 故取常量而非查表。
 */
export const ANCHOR_COLD_START_RETRY_MAX = 3;

/**
 * 本队列消费的**全部** payload 形态 —— 路由键是 `job.name`, 判据住消费者面
 * (`marketdata-sync.worker.ts`)。两支**无继承无共用字段**, 联合而非交叉是刻意的。
 */
export type MarketdataSyncJobPayload = DimensionJobPayload | AnchorColdStartJobPayload;

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

  /**
   * 入队锚冷启动 job (060 T007)。两个调用点: outbox subscriber 首次触发 / worker 配额顺延重投。
   *
   * 🚨 **走的是构造器绑定的那一个 `this.queue` (`marketdata-sync`)** —— 另起队列 = 冷启动与
   * 夜间批**并发**打 vendor, 直接撞限频; 那条 `concurrency=1` 是限频的支柱 (plan §D3)。
   *
   * `retryMax` 默认取 {@link ANCHOR_COLD_START_RETRY_MAX}: 冷启动不是维度、没有自己的
   * `sync_dimension` 行, 故取常量而非查表。
   */
  async enqueueColdStart(
    payload: AnchorColdStartJobPayload,
    opts: { retryMax?: number; delayMs?: number } = {},
  ): Promise<Job<AnchorColdStartJobPayload>> {
    return this.queue.add(
      ANCHOR_COLD_START_JOB,
      payload,
      this.jobOpts({
        retryMax: opts.retryMax ?? ANCHOR_COLD_START_RETRY_MAX,
        ...(opts.delayMs !== undefined ? { delayMs: opts.delayMs } : {}),
      }),
    );
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
