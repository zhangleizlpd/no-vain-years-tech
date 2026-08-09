import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Queue, QueueEvents, Worker, type Job, type JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import { ALERT_QUEUE_REDIS } from './alert-queue-connection.js';
import { EvaluateAlertsUseCase, type EvaluateAlertsSummary } from './evaluate-alerts.usecase.js';
import { PushDispatchQueue } from './push-dispatch.processor.js';
import { closeWithTimeout } from '../security/close-with-timeout.js';
import {
  IntradayEvalProcessor,
  type IntradayTickOutcome,
  INTRADAY_TICK_SCHEDULER_ID,
  INTRADAY_TICK_PATTERN,
  INTRADAY_JOB_OPTS,
} from './intraday-eval.processor.js';

/** alert 自持单 queue (plan D1 调度自治, 不挂 017 调度链)。 */
export const ALERT_EVAL_QUEUE = 'alert-eval';

/** CLI 进程不消费 sentinel (镜像 017 D6 拓扑互斥: 全局唯一 worker 在 server 进程)。 */
export const ALERT_WORKER_DISABLED = 'ALERT_WORKER_DISABLED';

/**
 * eval job payload (触发源审计; 评估本身无参 — 幂等全量轮)。
 * `cron`/`cli` = EOD 全量轮 (021); `intraday-cron` = 024 盘中 5min tick (路由至 `IntradayEvalProcessor`)。
 */
export interface AlertEvalJobPayload {
  triggeredBy: 'cron' | 'cli' | 'intraday-cron';
}

/** job opts: 评估幂等 (tradeDate 唯一键) → attempts 1, 翌晨 catch-up tick 即重试面。 */
const EVAL_JOB_OPTS: JobsOptions = {
  attempts: 1,
  removeOnComplete: { count: 30 },
  removeOnFail: { count: 100 },
};

/**
 * 入队面 + repeatable 注册 (021 T012, FR-S04)。
 *
 * boot 幂等注册 (`onModuleInit` → upsertJobScheduler): 同 schedulerId 重复注册 =
 * 更新而非堆积 → 发版重启不丢 cron (repeatable 落 Redis, plan §prod 部署注意);
 * CLI 进程 boot 重复 upsert 同一期望态, 无害。两 tick (Asia/Shanghai):
 * `0 23 * * *` 主跑 (prod 三维度 22:00 同步后) + `0 8 * * *` 翌晨 catch-up
 * (兜同步晚到 — 幂等键保证重评估 no-op)。
 */
@Injectable()
export class AlertEvalQueue implements OnModuleInit, OnModuleDestroy {
  readonly queue: Queue;

  constructor(@Inject(ALERT_QUEUE_REDIS) connection: Redis) {
    this.queue = new Queue(ALERT_EVAL_QUEUE, { connection });
  }

  async onModuleInit(): Promise<void> {
    await this.registerRepeatables();
  }

  /** 幂等注册两 repeatable tick (upsert by schedulerId)。 */
  async registerRepeatables(): Promise<void> {
    const template = {
      name: 'eval',
      data: { triggeredBy: 'cron' } satisfies AlertEvalJobPayload,
      opts: EVAL_JOB_OPTS,
    };
    await this.queue.upsertJobScheduler(
      'alert-eval-nightly',
      { pattern: '0 23 * * *', tz: 'Asia/Shanghai' },
      template,
    );
    await this.queue.upsertJobScheduler(
      'alert-eval-catchup',
      { pattern: '0 8 * * *', tz: 'Asia/Shanghai' },
      template,
    );
    // 024 T008: 盘中 5min tick (全天注册, 交易时段 gate 在 IntradayEvalProcessor 内, plan D1)。
    await this.queue.upsertJobScheduler(
      INTRADAY_TICK_SCHEDULER_ID,
      { pattern: INTRADAY_TICK_PATTERN, tz: 'Asia/Shanghai' },
      {
        name: 'eval',
        data: { triggeredBy: 'intraday-cron' } satisfies AlertEvalJobPayload,
        opts: INTRADAY_JOB_OPTS,
      },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await closeWithTimeout('alert-eval queue', () => this.queue.close());
  }
}

/**
 * 评估 worker (021 T012): 裸 `new Worker` 消费 `alert-eval`, processor 纯委托
 * `EvaluateAlertsUseCase` (幂等全量轮, concurrency 1 — 并发轮次无意义且互撞 P2002)。
 *
 * 启停门: `ALERT_WORKER_DISABLED` **或** `MARKETDATA_WORKER_DISABLED` 置位 → 不启动。
 * 后者用字符串字面量而非 import (boundaries 白名单不含 marketdata): 任一 CLI 进程
 * (各自置己侧 sentinel) 都不该顺带消费 alert 队列 — 全局唯一 worker 在 server 进程
 * 的拓扑互斥对两 ctx 同时成立。QueueEvents `failed` 监听 = 硬失败结构化 ERROR log
 * (log-based alerting 出口, 017 同款分工)。
 */
@Injectable()
export class AlertEvalWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AlertEvalWorker.name);
  private worker?: Worker<AlertEvalJobPayload>;
  private events?: QueueEvents;

  constructor(
    @Inject(ALERT_QUEUE_REDIS) private readonly connection: Redis,
    private readonly evaluateAlerts: EvaluateAlertsUseCase,
    private readonly pushDispatchQueue: PushDispatchQueue,
    private readonly intradayProcessor: IntradayEvalProcessor,
  ) {}

  /** worker 是否已启动 (sentinel 断言面 + 测试观察点)。 */
  get running(): boolean {
    return this.worker !== undefined;
  }

  async onModuleInit(): Promise<void> {
    if (process.env[ALERT_WORKER_DISABLED] || process.env['MARKETDATA_WORKER_DISABLED']) {
      this.logger.log('CLI sentinel 置位 — alert-eval worker 不启动 (本进程只入队不消费)');
      return;
    }
    this.worker = new Worker<AlertEvalJobPayload>(ALERT_EVAL_QUEUE, (job) => this.process(job), {
      connection: this.connection,
      concurrency: 1,
    });
    this.events = new QueueEvents(ALERT_EVAL_QUEUE, { connection: this.connection });
    this.events.on('failed', ({ jobId, failedReason }) => {
      this.logger.error(`alert-eval job failed: ${JSON.stringify({ jobId, failedReason })}`);
    });
  }

  /**
   * processor: 按 payload 路由 (job 无参)。`intraday-cron` → 盘中 tick (交易时段 gate + 熔断 +
   * 双模求值, 024 T008); 其余 (`cron`/`cli`) → 021 EOD 全量轮 + 即时 enqueue push-dispatch。
   * summary/outcome 入 bullmq returnvalue 供排障。
   */
  async process(
    job: Job<AlertEvalJobPayload>,
  ): Promise<EvaluateAlertsSummary | IntradayTickOutcome> {
    if (job.data.triggeredBy === 'intraday-cron') {
      return this.intradayProcessor.process();
    }
    this.logger.log(`alert-eval round start (triggeredBy=${job.data.triggeredBy})`);
    const summary = await this.evaluateAlerts.execute();
    // 调度双轨主路径 (022 T006, plan D5): eval 完成即时 enqueue dispatch (SC-001 ≤5min)。
    // best-effort — enqueue 失败不废已成功的评估轮 (delivery 行已落, 5min sweep 兜底)。
    try {
      await this.pushDispatchQueue.enqueueNow('eval');
    } catch (e) {
      this.logger.error(
        `push-dispatch enqueue after eval failed (sweep 兜底): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return summary;
  }

  async onModuleDestroy(): Promise<void> {
    // 顺序照 BullMQ 官方: worker → events(→ queue 在各自 provider)。超时兜底见 closeWithTimeout。
    await closeWithTimeout('alert-eval worker', async () => this.worker?.close());
    await closeWithTimeout('alert-eval events', async () => this.events?.close());
  }
}
