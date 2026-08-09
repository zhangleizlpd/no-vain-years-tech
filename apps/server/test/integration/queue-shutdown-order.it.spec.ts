import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Queue, Worker } from 'bullmq';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { QueueRedisLifecycle } from '../../src/marketdata/marketdata-queue-connection';
import { AlertQueueRedisLifecycle } from '../../src/alert/alert-queue-connection';

/**
 * 关停顺序回归 IT —— 锁死一条不变量：
 *
 *   **任一 BullMQ 消费方的 `onModuleDestroy` 执行时，它用的队列 Redis 连接必须仍然可用。**
 *
 * 为什么这条值钱（2026-08-02 实证，见 docs/improvements/2026-08/08-02-bullmq-shutdown-order.md）：
 * 队列连接按 BullMQ 硬要求配了 `maxRetriesPerRequest: null` = **命令无限重试**。若连接先于
 * worker 被 `disconnect()`，那么 worker 收尾一个 job 时发出的 `moveToFinished` 会永远重试、
 * 永远失败 —— 100% CPU 空转、**进程永不退出**。表现是 vitest 全量「挂死」十几分钟且日志空白
 * （nx 按 task 缓冲），而 `pkill` 还杀不掉它（JS 死循环阻塞事件循环 ⇒ SIGTERM 排不上队，
 * 只能 SIGKILL）。
 *
 * 官方规定的顺序（https://docs.bullmq.io/guide/connections）：
 *   await worker.close(); await queue.close(); connection.disconnect();
 * 各 processor 自己已按此写；坏的是**跨 provider** 的相对顺序，靠注册顺序碰运气。
 *
 * 修法用 NestJS 的段间屏障：连接断开挪到 `onApplicationShutdown`，而 Nest 保证
 * **所有** `onModuleDestroy` 跑完才进入该段（https://docs.nestjs.com/fundamentals/lifecycle-events）。
 *
 * 🚨 本测试**不去触发**那个死循环 —— 触发了测试自己就挂了。它断言的是不变量本身：
 * 用一个观察者 provider 在自己的 `onModuleDestroy` 里记录连接状态。
 * 同理不要在观察者里 `await client.ping()`：连接若已断，`maxRetriesPerRequest: null`
 * 会让这条 ping 永远重试而不是 reject，测试直接挂死。只读 `.status`。
 *
 * 存储选型：**只要 Redis、不要 PG**，故自起 `RedisContainer` 而不走 `isolated-db.ts` 三入口
 * （那三个都会附带克隆一个用不上的 PG 库）—— 判据见 testing.md §4 步 3。
 */
describe('队列连接关停顺序（BullMQ 无限重试 + 提前 disconnect = 进程永不退出）', () => {
  let container: StartedRedisContainer;
  let redisUrl: string;

  beforeAll(async () => {
    container = await new RedisContainer('redis:7-alpine').start();
    redisUrl = container.getConnectionUrl();
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  });

  /** 观察者：模拟一个 BullMQ 消费方，在自己的 onModuleDestroy 里记录连接是否还活着。 */
  @Injectable()
  class ConsumerProbe implements OnModuleDestroy {
    statusAtDestroy: string | undefined;
    constructor(private readonly lifecycle: { client: { status: string } }) {}
    /**
     * 🚨 **必须是 async 且真的耗时** —— 这是关键的现场条件：真 worker 的 `onModuleDestroy`
     * 里 `await worker.close()` 会**等 in-flight job 跑完**（BullMQ 官方：该调用自身不超时），
     * 而 lifecycle 的 `disconnect()` 是**同步**的。同步的那个会插到 async 的中间。
     * 用同步探针测不出来 —— 2026-08-02 第一版就是这样假绿的。
     */
    async onModuleDestroy(): Promise<void> {
      await new Promise((r) => setTimeout(r, 80));
      this.statusAtDestroy = this.lifecycle.client.status;
    }
  }

  /**
   * providers 顺序**刻意镜像真模块**（`marketdata.module.ts` 里 queue redis providers 注册在
   * worker 之前）—— 这正是缺陷得以发生的现场条件，别为了让测试好过而调换。
   */
  async function probeShutdown(
    makeLifecycle: () => { client: { status: string } },
  ): Promise<string | undefined> {
    const LIFECYCLE = Symbol('LIFECYCLE');
    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: LIFECYCLE, useFactory: makeLifecycle },
        {
          provide: ConsumerProbe,
          useFactory: (l: never) => new ConsumerProbe(l),
          inject: [LIFECYCLE],
        },
      ],
    }).compile();
    const probe = moduleRef.get(ConsumerProbe);
    await moduleRef.close();
    return probe.statusAtDestroy;
  }

  it('marketdata 队列连接：消费方 onModuleDestroy 时连接仍可用（非 end）', async () => {
    const status = await probeShutdown(() => new QueueRedisLifecycle(redisUrl));
    expect(status).not.toBe('end');
  });

  it('alert 队列连接：消费方 onModuleDestroy 时连接仍可用（非 end）', async () => {
    const status = await probeShutdown(() => new AlertQueueRedisLifecycle(redisUrl));
    expect(status).not.toBe('end');
  });

  /**
   * #824 的实质：优雅关停之所以值钱，是因为 `close()` **会等 in-flight job 跑完**
   * （BullMQ 官方：该调用等所有当前 job 处理完或失败）。若不等，job 变 stalled——
   * 而本仓是**单实例部署**，没有第二个 worker 来接管。
   *
   * 这条与上面两条互补：上面证「关停时连接还活着」，这条证「关停真的在等」。
   */
  it('close() 会等 in-flight job 跑完（#824 优雅关停的实质）', async () => {
    const lifecycle = new QueueRedisLifecycle(redisUrl);
    const QUEUE = 'shutdown-inflight-probe';
    let finished = false;
    let started!: () => void;
    const hasStarted = new Promise<void>((r) => (started = r));

    const queue = new Queue(QUEUE, { connection: lifecycle.client });
    const worker = new Worker(
      QUEUE,
      async () => {
        started();
        await new Promise((r) => setTimeout(r, 300));
        finished = true;
        return 'ok';
      },
      { connection: lifecycle.client, concurrency: 1 },
    );

    const moduleRef = await Test.createTestingModule({
      providers: [
        {
          provide: 'CONSUMER',
          // 形态镜像真 worker provider：onModuleDestroy 里 await worker.close()
          useValue: {
            async onModuleDestroy() {
              await worker.close();
            },
          },
        },
      ],
    }).compile();

    await queue.add('slow', {});
    await hasStarted; // 确保 job 真的在处理中，而不是关停时队列还空着
    expect(finished).toBe(false); // 前置条件：此刻 job 尚未完成

    await moduleRef.close();

    expect(finished).toBe(true); // ⇐ close() 等到了它
    await queue.close();
    lifecycle.onApplicationShutdown();
  }, 30_000);
});
