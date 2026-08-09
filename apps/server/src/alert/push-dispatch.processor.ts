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
import { closeWithTimeout } from '../security/close-with-timeout.js';
import {
  DispatchPushDeliveriesUseCase,
  type DispatchPushSummary,
} from './dispatch-push-deliveries.usecase.js';

/** push 送达 dispatch 专属 queue (022 T006, plan D5 — 复用 alert 自持 Redis 连接)。 */
export const PUSH_DISPATCH_QUEUE = 'push-dispatch';

/** dispatch job payload (触发源审计; 轮次本身无参 — 幂等到期扫描)。 */
export interface PushDispatchJobPayload {
  triggeredBy: 'eval' | 'sweep' | 'cli';
}

/** job opts: 轮次 = 幂等扫描 → attempts 1, 失败轮由 5min sweep 自然补 (D5 双轨)。 */
const DISPATCH_JOB_OPTS: JobsOptions = {
  attempts: 1,
  removeOnComplete: { count: 30 },
  removeOnFail: { count: 100 },
};

/**
 * dispatch 入队面 + repeatable 注册 (022 T006, plan D5 调度双轨)。
 *
 * 双轨: ① eval round 完成后 `enqueueNow` 即时一发 (SC-001 ≤5min 主路径) +
 * ② repeatable `每 5min` sweep (重试到期 + 漏发兜底)。boot 幂等注册 (upsert by
 * schedulerId, 021 AlertEvalQueue 同款 — 发版重启不丢 cron, repeatable 落 Redis)。
 */
@Injectable()
export class PushDispatchQueue implements OnModuleInit, OnModuleDestroy {
  readonly queue: Queue;

  constructor(@Inject(ALERT_QUEUE_REDIS) connection: Redis) {
    this.queue = new Queue(PUSH_DISPATCH_QUEUE, { connection });
  }

  async onModuleInit(): Promise<void> {
    await this.registerRepeatables();
  }

  /** 幂等注册 sweep tick (upsert by schedulerId)。 */
  async registerRepeatables(): Promise<void> {
    await this.queue.upsertJobScheduler(
      'push-dispatch-sweep',
      { pattern: '*/5 * * * *', tz: 'Asia/Shanghai' },
      {
        name: 'dispatch',
        data: { triggeredBy: 'sweep' } satisfies PushDispatchJobPayload,
        opts: DISPATCH_JOB_OPTS,
      },
    );
  }

  /** eval 完成后的即时入队面 (SC-001 主路径)。 */
  async enqueueNow(triggeredBy: 'eval' | 'cli' = 'eval'): Promise<void> {
    await this.queue.add(
      'dispatch',
      { triggeredBy } satisfies PushDispatchJobPayload,
      DISPATCH_JOB_OPTS,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await closeWithTimeout('push-dispatch queue', () => this.queue.close());
  }
}

/**
 * dispatch worker (022 T006): 裸 `new Worker` 消费 `push-dispatch`, processor 纯委托
 * `DispatchPushDeliveriesUseCase` (到期扫描幂等, concurrency 1 — 并发轮互撞无意义,
 * conditional updateMany 下 lost 行 no-op 但白耗 gateway 调用)。
 *
 * 启停门: sentinel 用字符串字面量而非 import — `ALERT_WORKER_DISABLED` 常量在
 * alert-eval.processor.ts, 而该文件 import 本文件 (eval 完成即时 enqueue), 反向
 * import 成环; `MARKETDATA_WORKER_DISABLED` 字面量理由同 021 (boundaries 白名单
 * 不含 marketdata)。语义同 AlertEvalWorker: 任一 CLI 进程都不消费 alert 队列。
 */
@Injectable()
export class PushDispatchWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PushDispatchWorker.name);
  private worker?: Worker<PushDispatchJobPayload>;
  private events?: QueueEvents;

  constructor(
    @Inject(ALERT_QUEUE_REDIS) private readonly connection: Redis,
    private readonly dispatchPushDeliveries: DispatchPushDeliveriesUseCase,
  ) {}

  /** worker 是否已启动 (sentinel 断言面 + 测试观察点)。 */
  get running(): boolean {
    return this.worker !== undefined;
  }

  async onModuleInit(): Promise<void> {
    if (process.env['ALERT_WORKER_DISABLED'] || process.env['MARKETDATA_WORKER_DISABLED']) {
      this.logger.log('CLI sentinel 置位 — push-dispatch worker 不启动 (本进程只入队不消费)');
      return;
    }
    this.worker = new Worker<PushDispatchJobPayload>(
      PUSH_DISPATCH_QUEUE,
      (job) => this.process(job),
      { connection: this.connection, concurrency: 1 },
    );
    this.events = new QueueEvents(PUSH_DISPATCH_QUEUE, { connection: this.connection });
    this.events.on('failed', ({ jobId, failedReason }) => {
      this.logger.error(`push-dispatch job failed: ${JSON.stringify({ jobId, failedReason })}`);
    });
  }

  /** processor: 纯委托 dispatch UC (summary 入 bullmq returnvalue 供排障)。 */
  async process(job: Job<PushDispatchJobPayload>): Promise<DispatchPushSummary> {
    this.logger.log(`push-dispatch round start (triggeredBy=${job.data.triggeredBy})`);
    return this.dispatchPushDeliveries.execute();
  }

  async onModuleDestroy(): Promise<void> {
    await closeWithTimeout('push-dispatch worker', async () => this.worker?.close());
    await closeWithTimeout('push-dispatch events', async () => this.events?.close());
  }
}
