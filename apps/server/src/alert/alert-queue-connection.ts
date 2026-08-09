import type { OnApplicationShutdown, Provider } from '@nestjs/common';
import { Redis } from 'ioredis';
import { redisConfig, type RedisConfig } from '../config/index.js';

/** DI token: alert 自持 bullmq 专用 ioredis 连接 (Queue/Worker/QueueEvents 共享)。 */
export const ALERT_QUEUE_REDIS = Symbol('ALERT_QUEUE_REDIS');

/** lifecycle 内部 token (镜像 marketdata-queue-connection 形态)。 */
const QUEUE_REDIS_LIFECYCLE = Symbol('ALERT_QUEUE_REDIS_LIFECYCLE');

/**
 * alert 队列专用 Redis 连接 (021 T012, plan D1 调度自治)。
 *
 * **镜像** `marketdata-queue-connection.ts` provider 模式而**不 import 复用**:
 * boundaries 单向白名单 alert→{account,security} 不含 marketdata (ADR-0052 叶子 ctx),
 * 且两 ctx 各持连接对象 — 队列生命周期互不耦合 (plan §调度)。
 *
 * bullmq Worker 硬要求 `maxRetriesPerRequest: null`; 不复用共享 `REDIS_CLIENT`
 * (缓存用, 默认 20 次重试) — 理由同 017 T002。断开挂 `OnApplicationShutdown`（见下方 🚨）。
 */
export class AlertQueueRedisLifecycle implements OnApplicationShutdown {
  readonly client: Redis;

  constructor(url: string) {
    this.client = new Redis(url, { maxRetriesPerRequest: null });
  }

  /**
   * 🚨 断连挂在 **`onApplicationShutdown`**，不是 `onModuleDestroy` —— 这一条是防死循环的，
   * 别"顺手"挪回去。
   *
   * 本连接按 BullMQ 硬要求配了 `maxRetriesPerRequest: null` = **命令无限重试**。而消费方
   * （Worker/QueueEvents）的 `onModuleDestroy` 里 `await worker.close()` 会**等 in-flight job
   * 跑完**（BullMQ 官方明说该调用自身不超时）。Nest 对同模块 providers 的 `onModuleDestroy`
   * **不串行**，于是同步的 `disconnect()` 会插到那个 await 中间 ⇒ job 收尾时的 `moveToFinished`
   * 对着已断连接**无限重试** ⇒ 100% CPU、**进程永不退出**（且 JS 死循环阻塞事件循环，
   * `SIGTERM` 排不上队，`pkill` 杀不掉，只能 `SIGKILL`）。
   *
   * NestJS 的关停分三段且**段间是全局屏障**：所有 `onModuleDestroy` 跑完（含 await）才进入
   * `beforeApplicationShutdown` / `onApplicationShutdown`。挂到后者即**结构性保证**消费方先关，
   * 不再依赖 provider 注册顺序碰运气。
   * 依据：https://docs.bullmq.io/guide/connections（关闭顺序）
   *      https://docs.nestjs.com/fundamentals/lifecycle-events（段间屏障）
   * 回归测试：test/integration/queue-shutdown-order.it.spec.ts
   */
  onApplicationShutdown(): void {
    this.client.disconnect();
  }
}

/** module providers: lifecycle (持有连接 + 销毁钩子) → client (消费侧注入面)。 */
export const alertQueueRedisProviders: Provider[] = [
  {
    provide: QUEUE_REDIS_LIFECYCLE,
    inject: [redisConfig.KEY],
    useFactory: (cfg: RedisConfig) => new AlertQueueRedisLifecycle(cfg.url),
  },
  {
    provide: ALERT_QUEUE_REDIS,
    inject: [QUEUE_REDIS_LIFECYCLE],
    useFactory: (lifecycle: AlertQueueRedisLifecycle) => lifecycle.client,
  },
];
