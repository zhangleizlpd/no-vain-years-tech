import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import type { Job } from 'bullmq';
import {
  PUSH_DISPATCH_QUEUE,
  PushDispatchQueue,
  PushDispatchWorker,
  type PushDispatchJobPayload,
} from './push-dispatch.processor';
import type {
  DispatchPushDeliveriesUseCase,
  DispatchPushSummary,
} from './dispatch-push-deliveries.usecase';

// 022 T006 单测: sweep repeatable 注册幂等 / enqueueNow 即时入队 / processor 委托
// dispatch UC / sentinel 启停门 (镜像 021 alert-eval.processor.spec 体例)。
// dispatch 态机分支归 dispatch-push-deliveries.usecase.spec (Testcontainers PG)。
describe('push-dispatch queue + worker (022 T006)', () => {
  let container: StartedRedisContainer;
  let connection: Redis;

  beforeAll(async () => {
    container = await new RedisContainer('redis:7-alpine').start();
    connection = new Redis(container.getConnectionUrl(), { maxRetriesPerRequest: null });
  }, 120_000);

  afterAll(async () => {
    connection.disconnect();
    await container?.stop();
  });

  afterEach(() => {
    delete process.env['ALERT_WORKER_DISABLED'];
    delete process.env['MARKETDATA_WORKER_DISABLED'];
  });

  const summaryStub: DispatchPushSummary = {
    scanned: 1,
    sent: 1,
    retryScheduled: 0,
    failed: 0,
    failedInvalid: 0,
    skippedUnbound: 0,
    errors: 0,
  };

  it('registerRepeatables 幂等: 重复 boot 注册 → 恰 1 sweep scheduler (*/5min, Asia/Shanghai)', async () => {
    const dispatchQueue = new PushDispatchQueue(connection);
    try {
      await dispatchQueue.registerRepeatables();
      await dispatchQueue.registerRepeatables(); // 二次 boot (发版重启) → upsert 不堆积

      const schedulers = await dispatchQueue.queue.getJobSchedulers();
      expect(schedulers).toHaveLength(1);
      expect(schedulers[0]?.key).toBe('push-dispatch-sweep');
      expect(schedulers[0]?.pattern).toBe('*/5 * * * *');
      expect(schedulers[0]?.tz).toBe('Asia/Shanghai');
    } finally {
      await dispatchQueue.queue.close();
    }
  });

  it('enqueueNow: 即时入队一发 dispatch job (triggeredBy 透传审计)', async () => {
    const dispatchQueue = new PushDispatchQueue(connection);
    try {
      await dispatchQueue.enqueueNow('eval');

      const jobs = await dispatchQueue.queue.getJobs(['waiting']);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.name).toBe('dispatch');
      expect(jobs[0]?.data).toEqual({ triggeredBy: 'eval' });
      await jobs[0]?.remove(); // 清场, 不留 waiting 干扰他例
    } finally {
      await dispatchQueue.queue.close();
    }
  });

  it('processor 委托 UC: process() → DispatchPushDeliveriesUseCase.execute() 一次, 返 summary', async () => {
    let calls = 0;
    const uc = {
      execute: async () => {
        calls += 1;
        return summaryStub;
      },
    } as unknown as DispatchPushDeliveriesUseCase;
    const worker = new PushDispatchWorker(connection, uc);

    const result = await worker.process({
      name: 'dispatch',
      data: { triggeredBy: 'sweep' },
    } as Job<PushDispatchJobPayload>);
    expect(calls).toBe(1);
    expect(result).toEqual(summaryStub);
  });

  it('sentinel 启停门: ALERT_WORKER_DISABLED 或 MARKETDATA_WORKER_DISABLED 置位 → worker 不启动', async () => {
    const uc = { execute: async () => summaryStub } as unknown as DispatchPushDeliveriesUseCase;

    process.env['ALERT_WORKER_DISABLED'] = '1';
    const gatedOwn = new PushDispatchWorker(connection, uc);
    await gatedOwn.onModuleInit();
    expect(gatedOwn.running).toBe(false);

    delete process.env['ALERT_WORKER_DISABLED'];
    process.env['MARKETDATA_WORKER_DISABLED'] = '1'; // marketdata CLI 进程在场 → alert 同不消费
    const gatedForeign = new PushDispatchWorker(connection, uc);
    await gatedForeign.onModuleInit();
    expect(gatedForeign.running).toBe(false);
  });

  it('queue 常量形态 (IT / CLI 共用锚)', () => {
    expect(PUSH_DISPATCH_QUEUE).toBe('push-dispatch');
  });
});
