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
  DEFAULT_QUEUE_LANE,
  MARKETDATA_WORKER_DISABLED,
  MarketdataSyncQueue,
  dimensionJobName,
  queueNameForLane,
  type QueueLane,
  type AnchorColdStartJobPayload,
  type DimensionJobPayload,
  type MarketdataSyncJobPayload,
} from './marketdata-sync.queue.js';
import { INTERRUPT_REASON, SyncRunRecorder, type SyncRunStats } from './sync-run.recorder.js';
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
 * 锁续期窗口 (bullmq 默认 30 s → 10 min)。
 *
 * 🚨 **不是按 job 时长定的**: 锁由 worker 每 `lockDuration/2` 自动续一次, job 跑多久都不该
 * 失锁。它要覆盖的是**event loop 被连续堵住的最长时间** —— 续期定时器排在 event loop 上,
 * 进程一卡, 续期就跟着卡。
 *
 * 2026-09-05 那次整机内存耗尽, 进程被磁盘 IO 拖到分钟级无响应, 30 s 默认值当场失锁, bullmq
 * 判 stalled 后把同一个 job 重投 ⇒ 「内存压力 → 失锁 → 重投 → 又跑一遍 → 更大内存压力」的
 * 正反馈环。本值与下面的 `maxStalledCount` 是这个环的两道闸, 成对存在。
 * EVIDENCE: `docker logs` 的 `Missing lock for job …` × 2 (moveToFinished / moveToDelayed);
 *           `marketdata.sync_run` 里同一 `bull_job_id` 出现两行 (06:44:31 起 / 06:51:53 起)。
 *
 * 代价 (已知且接受): 真僵死 (worker 进程没了) 的 job 要等满 10 min 才被 stalled checker 发现。
 * 恢复慢一轮, 远好过把机器夯到人工重启。
 */
const WORKER_LOCK_DURATION_MS = 600_000;

/**
 * stalled job 允许被救回 `wait` 的次数 (bullmq 默认 1 → 0) = **失锁一次就不再跑第二遍**,
 * 上面那个正反馈环的另一道闸。
 *
 * 📌 bullmq 5.78.0 的真实语义与「僵死不重投」的直觉说法**不同**, 记在这里免得下次误判:
 * 超过本值时 job **仍会被放回 `wait`**, 只是先在 job hash 上写下 `defa` (deferred failure);
 * worker 下次取到它, 在**跑 processor 之前**就以 `UnrecoverableError` 直接失败。
 * ⇒ 「重投一次」发生了、「重跑一次」没有 —— 那一轮的活确实不会被执行第二遍, 而 `failed`
 * 事件照常发出, 本类 `onJobFailed` 会收敛僵尸 `sync_run` 行并打 ERROR (不是静默丢)。
 * EVIDENCE: bullmq 5.78.0 源码 —— `scripts/moveStalledJobsToWait-8.js` (`stc` 自增 → 写
 *           `defa` → 仍走 moveJobToWait); `classes/job.js` (`defa` → `deferredFailure`;
 *           `shouldRetryJob` 见 UnrecoverableError 恒返 false); `classes/worker.js`
 *           (取到 job 先查 `getUnrecoverableErrorMessage`, 命中即抛, 不进 processor)。
 *
 * 代价 (已知且接受): 被判 stalled 的那一轮不会自动补, 等下一次调度或手动补采。
 */
const WORKER_MAX_STALLED_COUNT = 0;

/**
 * #491 对账兜底的周期 (启动时另跑一次)。
 *
 * 业内同类「事件为主 + 低频全量兜底」: Sidekiq Pro super_fetch 孤儿全量扫描每小时一次 (Reliability
 * wiki), K8s 系控制器 resync 默认 10 h。本兜底只补「进程活着但 QueueEvents 断连期间漏的事件」
 * —— 重启场景由启动那一轮 + 订阅起点 (`eventStreamTail`) 覆盖; 漏收代价只是审计表多挂一行
 * running ⇒ 取 1 h。
 */
const ORPHAN_RECONCILE_INTERVAL_MS = 3_600_000;

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
 * 告警分工两道: executor 内业务降级告警 (`failed` 计数阈值, per-dim) / 本类 QueueEvents
 * `failed` 监听 = retry 耗尽硬失败 (结构化 ERROR log, FR-S17 log-based alerting 出口)。
 *
 * 启停门 (D6): `MARKETDATA_WORKER_DISABLED` sentinel 置位 → onModuleInit no-op (CLI 进程
 * 只入队不消费, clarify Q2); OnModuleDestroy close 全对象 (镜像 QueueRedisLifecycle 对称)。
 */
@Injectable()
export class MarketdataSyncWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MarketdataSyncWorker.name);
  /** 每条 active lane 一个 Worker + 一个 QueueEvents (#210)。 */
  private readonly workers: Worker<MarketdataSyncJobPayload>[] = [];
  private readonly events: QueueEvents[] = [];
  private reconcileTimer?: NodeJS.Timeout;

  constructor(
    @Inject(MARKETDATA_QUEUE_REDIS) private readonly connection: Redis,
    private readonly executors: DimensionExecutorRegistry,
    private readonly syncQueue: MarketdataSyncQueue,
    private readonly coldStart: AnchorColdStartUseCase,
    @Inject(marketdataSyncConfig.KEY) private readonly cfg: MarketdataSyncConfig,
    private readonly runRecorder: SyncRunRecorder,
  ) {}

  /** worker 是否已启动 (sentinel 断言面 + 测试观察点)。 */
  get running(): boolean {
    return this.workers.length > 0;
  }

  async onModuleInit(): Promise<void> {
    if (process.env[MARKETDATA_WORKER_DISABLED]) {
      this.logger.log(`${MARKETDATA_WORKER_DISABLED} 置位 — worker 不启动 (CLI 入队进程, D6)`);
      return;
    }
    // #210: 每条 active lane 各起一个 Worker, **各自 concurrency: 1**。
    // 🚨 `concurrency` 保持 1 不是保守 —— 同一条 lane 内串行仍是我们要的 (同 vendor 的活
    //    一件件来); 拆的是**lane 之间**, 不是 lane 内部。别顺手把它调大。
    for (const lane of this.syncQueue.activeLanes()) {
      const queueName = queueNameForLane(lane);
      // #491: 订阅起点必须在 Worker 构造**之前**取 —— 理由见 eventStreamTail。
      const lastEventId = await this.eventStreamTail(lane);
      this.workers.push(
        new Worker<MarketdataSyncJobPayload>(queueName, (job) => this.process(job, lane), {
          connection: this.connection,
          concurrency: 1,
          // 内存压力下的 stalled 正反馈环两道闸 —— 理由与实测见两个常量各自的注释。
          lockDuration: WORKER_LOCK_DURATION_MS,
          maxStalledCount: WORKER_MAX_STALLED_COUNT,
        }),
      );
      const events = new QueueEvents(queueName, {
        connection: this.connection,
        ...(lastEventId !== undefined ? { lastEventId } : {}),
      });
      // retry 耗尽硬失败 (与 executor 内业务降级告警分工两道)。
      events.on('failed', ({ jobId, failedReason }) => {
        void this.onJobFailed(jobId, failedReason, lane);
      });
      this.events.push(events);
      this.logger.log(`marketdata-sync worker 启动: lane=${lane} queue=${queueName}`);
    }
    // #491 对账兜底: 启动一轮 (收上一个进程生命周期里漏掉的) + 周期一轮 (收断连期间漏掉的)。
    void this.reconcileOrphanedRuns();
    this.reconcileTimer = setInterval(() => {
      void this.reconcileOrphanedRuns();
    }, ORPHAN_RECONCILE_INTERVAL_MS);
    this.reconcileTimer.unref();
  }

  /**
   * 某 lane 事件流当前的末尾 id, 作 `QueueEvents` 的订阅起点 (#491)。
   *
   * 不传时 bullmq 从 `'$'` 读 = 只收**首次 XREAD 之后**的事件; 而 Worker 构造后立刻跑一次
   * stalled 检查, 上个进程被杀时在跑的 job 会在数百毫秒内 `failed` —— 与 QueueEvents 首次
   * XREAD 之间无先后保证, 漏了触发点 B 就永远等不到 (本地两臂 30 轮: `'$'` 漏 11/60, 从固定
   * 起点读漏 0/60, 维护者 2026-10-09 实测, 见 #491)。在 Worker 构造前取末尾 id ⇒ Worker 发出的
   * 每条事件都排在起点之后, 必被收到; 又不会把历史 `failed` 重放一遍刷 ERROR。
   * EVIDENCE: bullmq 5.78.0 `classes/queue-events.js` `consumeEvents` (`opts.lastEventId || '$'`);
   *           `classes/worker.js` `startStalledCheckTimer` (先跑一次 `moveStalledJobsToWait`)。
   *
   * 流为空 ⇒ `'0-0'` (从头读, 本就没有历史)。取失败 ⇒ WARN + 返 undefined 退回 `'$'` —— 起点
   * 只缩小窗口, 不值得为它把启动带崩; 漏掉的由对账兜底收。
   */
  private async eventStreamTail(lane: QueueLane): Promise<string | undefined> {
    const key = this.syncQueue.queueFor(lane).keys.events;
    try {
      const [last] = await this.connection.xrevrange(key, '+', '-', 'COUNT', 1);
      return last?.[0] ?? '0-0';
    } catch (err) {
      this.logger.warn(`事件流末尾 id 读取失败 (key=${key}), 退回 '$' 订阅: ${String(err)}`);
      return undefined;
    }
  }

  /**
   * #491 对账兜底: 把「job 已终结或已不在队列、行却仍 `running`」的 `sync_run` 收成 interrupted。
   *
   * 触发点 B 依赖 `failed` 事件送达, 而事件流不补投 (重启早于订阅 / 断连期间) ⇒ 漏一次就永久
   * running。本方法不看事件, 直接看 job 终态 —— 判据仍是确定性的, 不引入时间阈值:
   *   · job 在 `completed` / `failed` ⇒ 不会再有 attempt, 行不可能还有人收尾;
   *   · 所有 active lane 都查无此 job (被 removeOn* 挤掉) ⇒ 同上, 无从接管;
   *   · 其余状态 (active / wait / delayed / …) ⇒ **不动**: 正在跑的那一行归它自己收,
   *     将要被重跑的归触发点 A 收。
   *
   * 📌 job 用 (id, name) 双键认领: 各 lane 的 jobId 各自从 1 自增, 同一个 id 在两条 lane 上
   * 可以都存在; `sync_run.sync_type` 与维度 job 名同为 `sync:<dim>`, 名字对不上的不是它。
   *
   * 🚨 不抛 —— 挂在 setInterval / 启动 fire-and-forget 上。失败 WARN, 下一轮再来。
   */
  async reconcileOrphanedRuns(): Promise<void> {
    try {
      for (const { bullJobId, syncType } of await this.runRecorder.listRunningWithJob()) {
        if (await this.jobMayStillRun(bullJobId, syncType)) continue;
        await this.convergeInterruptedRuns(bullJobId, INTERRUPT_REASON.ORPHAN_RECONCILED);
      }
    } catch (err) {
      this.logger.warn(`sync_run 对账兜底失败: ${String(err)}`);
    }
  }

  private async jobMayStillRun(jobId: string, name: string): Promise<boolean> {
    for (const lane of this.syncQueue.activeLanes()) {
      const job = await this.syncQueue.queueFor(lane).getJob(jobId);
      if (job === undefined || job.name !== name) continue;
      const state = await job.getState();
      // 'unknown' = getJob 之后刚被移除, 与查无此 job 同论。
      return state !== 'completed' && state !== 'failed' && state !== 'unknown';
    }
    return false;
  }

  /**
   * `QueueEvents('failed')` 出口 = **retry 耗尽**, 不是每次 attempt 失败 —— bullmq 的
   * `Job.moveToFailed` 只在 `shouldRetryJob` 为假时才走 `moveToFinished(target='failed')`
   * (发本事件的那一条); 还能重试的走 `moveToDelayed`/`retryJob`, 发的是 `delayed`/`waiting`。
   *
   * 三件事: ① 结构化 ERROR log (FR-S17 log-based alerting 唯一出口, 既有);
   * ② #137 收敛触发点 B (补刀): 本事件 = 这个 job **再也不会被处理**, 故它名下若还挂着
   * `running` 行, 就永远等不到触发点 A 那位接管者了 —— 在这里收干净;
   * ③ 冷启动 job 另补一笔 `retry_exhausted` 运行记录 (FR-019a) —— 维度 job **不**碰那张表。
   *
   * 📌 触发点 B **刻意挂 `failed` 而不是 `stalled`**: `stalled` 事件的投递与 worker 重新拉取
   * 该 job 是并发的, 事件晚到就会把**新 attempt 刚开的那一行**误标成 interrupted。而「会被重跑」
   * 的情形已由触发点 A 零竞态地覆盖, B 只需补「不会再被重跑」这一半 —— 那正是本事件的语义。
   *
   * 🚨 **本方法不许抛**: 它挂在事件监听上, 抛出去就是 unhandled rejection (进程级噪音,
   * 且吞不掉的那一刻正是 Redis / DB 已经不健康的时候)。落库失败降级成 WARN。
   */
  async onJobFailed(
    jobId: string,
    failedReason: string,
    lane: QueueLane = DEFAULT_QUEUE_LANE,
  ): Promise<void> {
    this.logger.error(
      `marketdata-sync job failed (retries exhausted): ${JSON.stringify({ jobId, failedReason })}`,
    );
    await this.convergeInterruptedRuns(jobId, INTERRUPT_REASON.RETRIES_EXHAUSTED);
    try {
      const job = await this.syncQueue.queueFor(lane).getJob(jobId);
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

  /**
   * #137 两个收敛触发点的共同出口: 把同 job 上没能自己收尾的 `sync_run` 行收成 `interrupted`。
   *
   * 🚨 **不抛** —— 两个调用点都不能被它带崩: 触发点 B 挂在事件监听上 (抛=unhandled rejection),
   * 触发点 A 后面跟着的是真正要干的活, 为「审计行没收干净」把整轮同步废掉是本末倒置。失败的
   * 代价只是**退回本 issue 之前的状态**(多一条僵尸行), 不会多坏。
   *
   * 但降级必须**有声** —— 这个机制自己坏掉且没有声音, 正是 #137 / #103 同族问题的病根。
   * ⇒ 失败走 WARN, 且收敛到行时打一行 log (0 行是稳态, 不打)。
   */
  private async convergeInterruptedRuns(jobId: string | undefined, reason: string): Promise<void> {
    // 类型上可选, 故守住 —— 空串会让 where 命中一片空。
    // ASSUMED: 「bullmq 入队即分配 id, 故此处恒非空」——**未验证**, 本仓无实测也未查文档。
    // 正因如此这道守卫不能省: 它错了就是 where 命中一片空、把别的 run 一起收敛掉, 而守住
    // 之后错不错都无所谓。⇒ 🚫 别据此把这个 guard 删了「简化」。
    if (jobId === undefined || jobId === '') return;
    try {
      const converged = await this.runRecorder.convergeInterrupted(jobId, reason);
      if (converged > 0) {
        this.logger.log(
          `sync_run 收敛 interrupted: ${JSON.stringify({ jobId, rows: converged, reason })}`,
        );
      }
    } catch (err) {
      this.logger.warn(`sync_run interrupted 收敛失败 (jobId=${jobId}): ${String(err)}`);
    }
  }

  /** processor: `job.name` 路由 —— `sync:anchor-cold-start` 走冷启动, 其余 `sync:<dim>` 走 executor。 */
  async process(
    job: Job<MarketdataSyncJobPayload>,
    // 📌 `lane` 给默认值与 `enqueueDimensionJob` 的「必填」是**刻意的不对称**: 本方法的生产
    //    调用方只有上面那个 Worker 闭包 (它恒显式传), 默认值只服务测试直调, 且 default 正是
    //    灰度关时的真实 lane。而入队面是开放 API, 漏传必须 typecheck 红。
    lane: QueueLane = DEFAULT_QUEUE_LANE,
  ): Promise<SyncRunStats | ColdStartResult> {
    if (isColdStartJob(job)) return this.processColdStart(job);
    return this.processDimension(job as Job<DimensionJobPayload>, lane);
  }

  /**
   * 冷启动分支 (060 plan §D3)。**不**进 `DimensionExecutorRegistry` —— 冷启动没有
   * `sync_dimension` 行, 也不该有 (它是事件驱动的一次性补数, 不是有水位的周期维度)。
   *
   * 顺延语义与维度分支逐字同源: `vendor_budget` ⇒ 延时重入队**同 payload**,
   * deferral ≠ failure 故不耗本 job attempts (FR-019b)。
   *
   * 📌 issue #159 前还有第二个 deferral `awaiting_chain` (第一相组完 flow 交回、第二相由
   * BullMQ parent 语义接着跑)。链改直调后两相合一, 该分支随之退役。
   */
  private async processColdStart(job: Job<AnchorColdStartJobPayload>): Promise<ColdStartResult> {
    const { ticker, anchorId } = job.data;
    if (typeof ticker !== 'string' || ticker === '' || !/^\d+$/.test(String(anchorId))) {
      // 非法 payload (生产者漂移) → 直接 fail, 与维度分支的 name/dimensionKey 校验同一形态。
      throw new Error(`${ANCHOR_COLD_START_JOB} payload 非法: ${JSON.stringify(job.data)}`);
    }
    const result = await this.coldStart.run({
      anchorId: BigInt(anchorId),
      ticker,
      now: new Date(),
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
  private async processDimension(
    job: Job<DimensionJobPayload>,
    lane: QueueLane,
  ): Promise<SyncRunStats> {
    const {
      dimensionKey,
      mode,
      asOf,
      backfillHistoryDays,
      maxEodInstruments,
      markets,
      noSkipComplete,
      triggeredBy,
    } = job.data;
    if (job.name !== dimensionJobName(dimensionKey)) {
      // 非法 payload (name/payload 漂移) → 直接 fail (不路由错维度)。
      throw new Error(`job name "${job.name}" 与 payload dimensionKey "${dimensionKey}" 不一致`);
    }
    // #137 收敛触发点 A (主): 开工前先把**同 job 上一次没收尾的 attempt** 收成 interrupted。
    // 🚨 必须在 execute() 之前 —— execute() 起手就 `recorder.start()` 开新行, 顺序反了就把自己
    // 刚开的那行当僵尸收掉。判据为何是确定性的 (不靠心跳/阈值) 见 convergeInterrupted 注释。
    await this.convergeInterruptedRuns(job.id, INTERRUPT_REASON.SUPERSEDED_BY_RETRY);
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
      // #202: 来历两列的输入 —— 触发源逐字来自 payload, 别在这里兜底成 'tick'
      // (漏传的路径要以 NULL 现形, 不是伪装成一轮按计划的执行)。
      { bullJobId: job.id, triggeredBy },
    );
    if (result.budgetExhausted) {
      // 配额顺延 (D5): standalone delayed job 重入队同 named job — 不进 flow、配额参数保留、
      // deferral ≠ failure 不耗本 job attempts。
      //
      // 🚨 **只有 `triggeredBy` 改写成 `'requeue'`** (#202): 顺延跑出来的是**同一轮的重入**,
      //   而它会开出第二行 `sync_run`。继续继承 `'tick'` 就等于让「连续 N 轮」的计数器把一轮
      //   数成两轮 —— 一次配额耗尽就能凭空吃掉一格阈值预算。
      await this.syncQueue.enqueueDimensionJob(
        { ...job.data, triggeredBy: 'requeue' },
        {
          retryMax: job.opts.attempts ?? 1,
          delayMs: this.cfg.requeueDelayMs,
          // 🚨 顺延必须回**同一条 lane** —— 回错 lane 就是把 futu 的活又扔回理杏仁队尾排队,
          //    而这条路径恰恰是配额耗尽时走的, 那时最不该再排队。
          lane,
        },
      );
      this.logger.log(
        `sync:${dimensionKey} 配额耗尽 — 顺延 re-enqueue (delay=${this.cfg.requeueDelayMs}ms, skipped=${result.stats.skipped})`,
      );
    }
    return result.stats;
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.reconcileTimer);
    for (const worker of this.workers) {
      await closeWithTimeout('marketdata-sync worker', () => worker.close());
    }
    for (const events of this.events) {
      await closeWithTimeout('marketdata-sync events', () => events.close());
    }
  }
}
