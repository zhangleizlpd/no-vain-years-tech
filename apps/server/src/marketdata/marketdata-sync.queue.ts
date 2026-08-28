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

/**
 * default lane 的 queue —— 拆 lane 前**唯一**的那一个 (理杏仁 / 东财 / cboe 全在此)。
 * 名字保持不变是刻意的: 灰度 flag 关时全部 job 仍落这里, Redis 里不出现新 key。
 */
export const MARKETDATA_SYNC_QUEUE = 'marketdata-sync';

/** futu lane 的 queue (issue #210): 期权链 / 快照 / IV / 美股日线 / 财报 + 锚冷启动。 */
export const MARKETDATA_SYNC_FUTU_QUEUE = 'marketdata-sync-futu';

/**
 * 执行 lane 值域 —— `SyncDimension.queueLane` 的**单一来源** (DB 侧无 enum/CHECK, 同
 * `status` / `triggered_by` 的取舍)。
 *
 * 🚨 **lane 的判据是「共享哪个限频令牌桶」**, 不是「哪个市场」也不是「哪个业务域」。拆 lane
 *    的全部收益来自「不同 vendor 的活不再互相排队」(bulkhead); cn 与 hk 共用同一个理杏仁桶,
 *    按市场拆只会让同一个桶被两条 lane 并发打 —— 那是**反向**收益。
 *
 * 🚨 **lane 不负责限频, 别把它当限频机制。** 限频的真正 enforcer 是传输层的**单例令牌桶**:
 *    每个 `VendorHttpClient` 是单例 provider (futu 还按 capability 拆了 5 个), 且
 *    `VendorRateLimiter.acquire()` 用一条 tail promise 链把并发调用 FIFO 排队 ⇒ 有几条 lane
 *    并发对限频**完全无影响**。这一点很重要: `universe` 走
 *    `UniverseFallbackChainAdapter([理杏仁, 富途, 东财])`, **本就是个多 vendor 维度** ⇒
 *    「一条 lane = 一个 vendor」从来不成立, MUST NOT 拿它当任何推导的前提。
 */
export const QUEUE_LANES = ['default', 'futu'] as const;

export type QueueLane = (typeof QUEUE_LANES)[number];

/** 未登记 / 灰度关 / 值不可识别时的归宿 —— 落回它 = 退化成拆 lane 前的现状, 不是坏数据。 */
export const DEFAULT_QUEUE_LANE: QueueLane = 'default';

/** lane → queue 名。新增 lane 必须同时在此登记, 否则 typecheck 红 (Record 穷尽)。 */
const QUEUE_NAME_BY_LANE: Record<QueueLane, string> = {
  default: MARKETDATA_SYNC_QUEUE,
  futu: MARKETDATA_SYNC_FUTU_QUEUE,
};

export function queueNameForLane(lane: QueueLane): string {
  return QUEUE_NAME_BY_LANE[lane];
}

/**
 * `SyncDimension.queueLane` 的原始值 → 生效 lane。**纯函数**, 全部入队点共用这一个判据。
 *
 * 两道收敛, 都刻意收敛到 `default` 而不是抛:
 *  1. `enabled === false` (灰度 flag 关) ⇒ 一律 `default` —— 这是回滚开关, 行为与拆 lane 前
 *     逐字节相同, 故 flag 关时 Redis 里不会出现 futu queue 的 key。
 *  2. 值不在 {@link QUEUE_LANES} 内 (DB 侧无约束, 手改 / 打错字都可能) ⇒ `default`。
 *     🚨 这里**不抛**是有取舍的: 抛会让一个打错字的 lane 值在 tick 里炸掉整轮组 flow
 *     (`tick()` 把异常吞成 ERROR log, 而告警无接收方 ⇒ 整夜静默瘫痪)。落回 default 的代价
 *     只是「那个维度退回和理杏仁排队」= 现状, 可观测、可自愈、不丢数据。
 */
export function resolveQueueLane(rawLane: string | null | undefined, enabled: boolean): QueueLane {
  if (!enabled) return DEFAULT_QUEUE_LANE;
  return (QUEUE_LANES as readonly string[]).includes(rawLane ?? '')
    ? (rawLane as QueueLane)
    : DEFAULT_QUEUE_LANE;
}

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
 *
 * 🚨 反过来, `same_day_retry` / `premarket_backfill` 这两个值**不经队列**: 它们是
 * `OptionSnapshotRemediation` 的两级 @Cron 直调采集本体后自己开的 SyncRun 行 (#261 续)。
 * 之所以仍收在这里, 是因为本类型是 `SyncRun.triggered_by` 的**值域单一来源** —— 判据侧
 * (「哪些行算一轮」) 只认这一份清单, 开第二处枚举就等于让判据的输入分叉。
 * 📌 两级各占一个值而不是合成一个 `'remediation'`: 它们**就是两个不同的触发源**(两个
 *    @Cron, 不同时刻、不同判据、不同落库口径)。合成一个之后「这一行是哪一级写的」只能
 *    按 `started_at` 反推 —— 而 #202 的结论恰恰是「按时刻猜」是最脆的那个判据。
 */
export type DimensionTriggeredBy =
  | 'tick'
  | 'cli'
  | 'cascade'
  | 'requeue'
  | 'anchor-cold-start'
  // 与 `RemediationLevel` 逐字同形 (option-snapshot-remediation.ts) —— 那边的值直接赋到这里,
  // 结构等价即编译期锁死, 无需互相 import (队列 → 补救器的依赖不该存在)。
  | 'same_day_retry'
  | 'premarket_backfill';

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
  /**
   * lane → Queue, **懒建**。灰度关时 `resolveLane()` 恒返 default ⇒ futu lane 从不被请求
   * ⇒ Redis 里**不会出现**它的任何 key。这是「回滚 = 翻 flag」能成立的另一半。
   */
  private readonly queues = new Map<QueueLane, Queue>();
  private flowProducer?: FlowProducer;

  constructor(
    @Inject(MARKETDATA_QUEUE_REDIS) private readonly connection: Redis,
    @Inject(marketdataSyncConfig.KEY) private readonly cfg: MarketdataSyncConfig,
  ) {}

  /**
   * default lane 的 Queue。**保留 `queue` 这个名字是刻意的** —— 灰度关时它就是拆 lane 前
   * 的那一个, 既有 IT 的断言面逐字不变, 「什么都没发生」才是真的。
   */
  get queue(): Queue {
    return this.queueFor(DEFAULT_QUEUE_LANE);
  }

  /** 取某条 lane 的 Queue (worker 按自己消费的 lane 取; 测试断言面)。 */
  queueFor(lane: QueueLane): Queue {
    const existing = this.queues.get(lane);
    if (existing !== undefined) return existing;
    const created = new Queue(queueNameForLane(lane), { connection: this.connection });
    this.queues.set(lane, created);
    return created;
  }

  /**
   * `SyncDimension.queueLane` 原始值 → 生效 lane。**灰度 flag 的唯一读取点** ——
   * 别在调用侧各读一次 `cfg.futuLaneEnabled`, 那是同一判据的第二处表达。
   */
  resolveLane(rawLane: string | null | undefined): QueueLane {
    return resolveQueueLane(rawLane, this.cfg.futuLaneEnabled);
  }

  /**
   * 本进程该起 worker 的 lane 集合。
   *
   * 灰度关 ⇒ 只有 default —— 一条都不多起, 于是 futu queue 在 Redis 里**连消费者都没有**,
   * 与「回滚 = 翻 flag」一致 (翻回去之后不会留一个空转的 worker 连着一个空队列)。
   */
  activeLanes(): readonly QueueLane[] {
    return this.cfg.futuLaneEnabled ? QUEUE_LANES : [DEFAULT_QUEUE_LANE];
  }

  /**
   * 入队单维度 job。`retryMax` 来自 SyncDimension 行 (调用方已载); `delayMs` 供顺延。
   *
   * 🚨 `lane` **必填, 蓄意不给默认值**: 给了默认值, 将来新加的入队路径会静默落进 default
   * lane —— 那正是本次要根除的「排在理杏仁后面」。必填 ⇒ 漏传是 typecheck 红, 不是夜里的
   * 一个惊喜。
   */
  async enqueueDimensionJob(
    payload: DimensionJobPayload,
    opts: { retryMax: number; lane: QueueLane; delayMs?: number },
  ): Promise<Job<DimensionJobPayload>> {
    return this.queueFor(opts.lane).add(
      dimensionJobName(payload.dimensionKey),
      payload,
      this.jobOpts(opts),
    );
  }

  /**
   * 入队锚冷启动 job (060 T007)。两个调用点: outbox subscriber 首次触发 / worker 配额顺延重投。
   *
   * 🚨 **恒落 futu lane** —— 冷启动调的就是 futu 的链发现与快照本体。
   *   沿革: 本处原注释写「必须走同一个 `marketdata-sync`, 另起队列 = 冷启动与夜间批并发打
   *   vendor 直接撞限频」。那句话的**结论**在 #210 被推翻, 但**担心的东西**没有: 限频的
   *   enforcer 是传输层单例令牌桶 (见 {@link QUEUE_LANES} 注释), 并发几条 lane 都撞不了限频;
   *   而把冷启动压在理杏仁 2h35m 长链后面是有实测代价的 —— 22:00 后建锚会被推过午夜,
   *   「黄金窗口」只剩交易日 21:30-21:59 (066 tasks.md)。
   *   ⚠️ 灰度关时它仍落 default lane (`resolveLane` 恒返 default), 行为与今天一致。
   *
   * `retryMax` 默认取 {@link ANCHOR_COLD_START_RETRY_MAX}: 冷启动不是维度、没有自己的
   * `sync_dimension` 行, 故取常量而非查表。
   */
  async enqueueColdStart(
    payload: AnchorColdStartJobPayload,
    opts: { retryMax?: number; delayMs?: number } = {},
  ): Promise<Job<AnchorColdStartJobPayload>> {
    return this.queueFor(this.resolveLane('futu')).add(
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
    // 只关**已建**的 lane —— 用 this.queue 会把 default lane 凭空建出来再关掉。
    for (const [lane, queue] of this.queues) {
      await closeWithTimeout(`${queueNameForLane(lane)} queue`, () => queue.close());
    }
  }
}
