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
   * 跑完**（官方 API 原文 "waits for current jobs to finalize"；不等待要显式传
   * `force`）。Nest 对同模块 providers 的 `onModuleDestroy`
   * **不串行**，于是同步的 `disconnect()` 会插到那个 await 中间 ⇒ job 收尾时的 `moveToFinished`
   * 对着已断连接**无限重试** ⇒ 100% CPU、**进程永不退出**（且 JS 死循环阻塞事件循环，
   * `SIGTERM` 排不上队，`pkill` 杀不掉，只能 `SIGKILL`）。
   *
   * EVIDENCE: 上面四条外部断言的出处 (2026-09-03 复核)。
   * ① ioredis 默认 `maxRetriesPerRequest = 20` —— 装在本仓的那份源码:
   *    `node_modules/.pnpm/ioredis@5.10.1/node_modules/ioredis/built/redis/RedisOptions.js:52`。
   * ② BullMQ 要求 Worker 侧置 null、语义是无限重试 —— 官方原文「retried indefinitely until
   *    Redis becomes available again」: https://docs.bullmq.io/bull/patterns/persistent-connections
   *    (另见 going-to-production: BullMQ 自身默认即 null, 覆盖它会告警)。
   * ③ `worker.close()` 等 in-flight job —— 官方 API: https://docs.bullmq.io/api/classes/v5.Worker.html
   * ④ Nest 同模块 providers 的 `onModuleDestroy` **不串行** —— 官方文档只写了「按 module import
   *    order / 层级」, **没有**记载同模块内的串并行, 故指针给装在本仓的源码:
   *    `@nestjs/core@11.1.21` 的 `hooks/on-module-destroy.hook.js` `callModuleDestroyHook`
   *    先 `.map(async (instance) => instance.onModuleDestroy())` 全部启动, 再
   *    `await Promise.all(...)` ⇒ 并发。升级 Nest 大版本时**必须回来复核这一条**。
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
