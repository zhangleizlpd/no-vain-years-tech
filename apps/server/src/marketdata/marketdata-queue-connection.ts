import type { OnApplicationShutdown, Provider } from '@nestjs/common';
import { Redis } from 'ioredis';
import { redisConfig, type RedisConfig } from '../config/index.js';

/** DI token: bullmq 专用 ioredis 连接 (Queue/Worker/QueueEvents/FlowProducer 共享)。 */
export const MARKETDATA_QUEUE_REDIS = Symbol('MARKETDATA_QUEUE_REDIS');

/** lifecycle 内部 token (镜像 security RedisLifecycle 形态)。 */
const QUEUE_REDIS_LIFECYCLE = Symbol('MARKETDATA_QUEUE_REDIS_LIFECYCLE');

/**
 * 队列专用 Redis 连接 (017 T002, FR-S13, plan D1)。
 *
 * **不复用**共享 `REDIS_CLIENT` (缓存用, ioredis 默认 maxRetriesPerRequest=20):
 * bullmq Worker **硬要求** `maxRetriesPerRequest: null` (手建 client 不置 null 会被
 * bullmq throw 拒, context7 connections.md) — 命令在 Redis 不可达期间无限重试, 保证
 * worker 只要连接恢复就继续消费。单实例即可共享给 Queue/Worker/QueueEvents/
 * FlowProducer (bullmq 对阻塞命令内部自行 duplicate)。
 *
 * 手控 provider (ADR-0043, security RedisLifecycle 先例);
 * 断开挂 `OnApplicationShutdown`（见下方 🚨）。
 */
export class QueueRedisLifecycle implements OnApplicationShutdown {
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
export const marketdataQueueRedisProviders: Provider[] = [
  {
    provide: QUEUE_REDIS_LIFECYCLE,
    inject: [redisConfig.KEY],
    useFactory: (cfg: RedisConfig) => new QueueRedisLifecycle(cfg.url),
  },
  {
    provide: MARKETDATA_QUEUE_REDIS,
    inject: [QUEUE_REDIS_LIFECYCLE],
    useFactory: (lifecycle: QueueRedisLifecycle) => lifecycle.client,
  },
];
