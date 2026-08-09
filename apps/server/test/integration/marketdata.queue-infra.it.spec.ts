import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import { Queue, QueueEvents, Worker } from 'bullmq';
import { QueueRedisLifecycle } from '../../src/marketdata/marketdata-queue-connection';

// 017 PR-1 队列基础设施 IT (Testcontainers Redis, T002+T004):
//  - T002: 队列专用连接 maxRetriesPerRequest=null (bullmq Worker 硬要求, 与共享 client
//    默认配置冲突 → 独立连接, plan D1) + 生命周期对称。
//  - T004: 裸 bullmq 在该连接上的 no-op roundtrip (单 ioredis 实例共享给 Queue/Worker/
//    QueueEvents, bullmq 对阻塞命令内部 duplicate) + removeOnComplete 留存上限 (noeviction
//    下 Redis 内存有界的机制锚, FR-S12)。
let container: StartedRedisContainer;
let shared: Redis; // 模拟既有共享 REDIS_CLIENT (默认配置, 锁/缓存用)。
let lifecycle: QueueRedisLifecycle;

beforeAll(async () => {
  container = await new RedisContainer('redis:7-alpine').start();
  shared = new Redis(container.getConnectionUrl());
  lifecycle = new QueueRedisLifecycle(container.getConnectionUrl());
}, 120_000);

afterAll(async () => {
  lifecycle?.onApplicationShutdown();
  shared?.disconnect();
  await container?.stop();
});

describe('017 T002 queue-dedicated Redis connection (maxRetriesPerRequest: null)', () => {
  it('① 队列连接 maxRetriesPerRequest=null; 共享 client 保持默认 (证配置冲突须独立连接)', () => {
    expect(lifecycle.client.options.maxRetriesPerRequest).toBeNull();
    // ioredis 默认 20 — 若复用共享 client 给 bullmq 会被 throw 拒。
    expect(shared.options.maxRetriesPerRequest).not.toBeNull();
  });

  it('② 双连接并存互不干扰 (共享 client 读写照常, 队列连接 ping 通)', async () => {
    await shared.set('shared:key', 'v');
    expect(await lifecycle.client.ping()).toBe('PONG');
    expect(await shared.get('shared:key')).toBe('v');
  });

  it('③ onApplicationShutdown 断开队列连接 (关停第二段, 保证晚于消费方 close)', async () => {
    const probe = new QueueRedisLifecycle(container.getConnectionUrl());
    expect(await probe.client.ping()).toBe('PONG');
    const ended = new Promise<void>((resolve) => probe.client.once('end', () => resolve()));
    probe.onApplicationShutdown();
    await ended; // disconnect 的状态翻转在下一拍 — 等 'end' 事件而非同步断言。
    expect(probe.client.status).toBe('end');
  });
});

describe('017 T004 bullmq roundtrip + 留存上限 (单连接共享 Queue/Worker/QueueEvents)', () => {
  it('④ no-op job 入队 → worker 处理 → waitUntilFinished 返回结果', async () => {
    const queue = new Queue('t004-roundtrip', { connection: lifecycle.client });
    const events = new QueueEvents('t004-roundtrip', { connection: lifecycle.client });
    await events.waitUntilReady();
    const processed: string[] = [];
    const worker = new Worker(
      't004-roundtrip',
      async (job) => {
        processed.push(job.name);
        return 'done';
      },
      { connection: lifecycle.client, concurrency: 1 },
    );
    try {
      const job = await queue.add('noop', { probe: 1 });
      const result: unknown = await job.waitUntilFinished(events, 10_000);
      expect(result).toBe('done');
      expect(processed).toEqual(['noop']);
    } finally {
      await worker.close();
      await events.close();
      await queue.close();
    }
  });

  it('⑤ removeOnComplete {count} 留存上限生效 (完成 job 超限被清, Redis 内存有界)', async () => {
    const queue = new Queue('t004-retention', { connection: lifecycle.client });
    const events = new QueueEvents('t004-retention', { connection: lifecycle.client });
    await events.waitUntilReady();
    const worker = new Worker('t004-retention', async () => 'ok', {
      connection: lifecycle.client,
      concurrency: 1,
    });
    try {
      const jobs = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          queue.add(`j${i}`, {}, { removeOnComplete: { count: 2 } }),
        ),
      );
      await Promise.all(jobs.map((j) => j.waitUntilFinished(events, 10_000)));
      const completed = await queue.getCompleted();
      expect(completed.length).toBeLessThanOrEqual(2); // 仅留最近 2 个, 其余被清。
    } finally {
      await worker.close();
      await events.close();
      await queue.close();
    }
  });
});
