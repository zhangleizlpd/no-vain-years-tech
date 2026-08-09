import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import type { Job } from 'bullmq';
import {
  ALERT_EVAL_QUEUE,
  ALERT_WORKER_DISABLED,
  AlertEvalQueue,
  AlertEvalWorker,
  type AlertEvalJobPayload,
} from './alert-eval.processor';
import type { EvaluateAlertsUseCase, EvaluateAlertsSummary } from './evaluate-alerts.usecase';
import type { PushDispatchQueue } from './push-dispatch.processor';
import type { IntradayEvalProcessor, IntradayTickOutcome } from './intraday-eval.processor';

/** 024 T008 intraday 路由替身: 记录是否被 worker 委托 + 返回 outcome。 */
function intradayProcessorStub(): { stub: IntradayEvalProcessor; calls: () => number } {
  let n = 0;
  const stub = {
    process: async (): Promise<IntradayTickOutcome> => {
      n += 1;
      return { status: 'skipped-session' };
    },
  } as unknown as IntradayEvalProcessor;
  return { stub, calls: () => n };
}

// 021 T012 单测: repeatable 注册幂等 (upsert job scheduler ×2) / processor 委托 UC /
// sentinel 启停门 (本 ctx + marketdata CLI 进程互斥)。队列消费全链路归 T013 IT。
// 022 T006 追加: eval round 完成 → 即时 enqueue push-dispatch (D5 双轨主路径,
// best-effort — enqueue 炸不废评估轮)。
describe('alert-eval queue + worker (021 T012)', () => {
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
    delete process.env[ALERT_WORKER_DISABLED];
    delete process.env['MARKETDATA_WORKER_DISABLED'];
  });

  const summaryStub: EvaluateAlertsSummary = {
    enabledAlerts: 1,
    triggered: 1,
    skippedNoBar: 0,
    skippedDuplicate: 0,
  };

  it('registerRepeatables 幂等: 重复 boot 注册 → 恰 3 scheduler (EOD nightly 23:00 + catchup 08:00 + 024 盘中 */5, Asia/Shanghai)', async () => {
    const evalQueue = new AlertEvalQueue(connection);
    try {
      await evalQueue.registerRepeatables();
      await evalQueue.registerRepeatables(); // 二次 boot (发版重启) → upsert 不堆积

      const schedulers = await evalQueue.queue.getJobSchedulers();
      expect(schedulers).toHaveLength(3);
      const byId = new Map(schedulers.map((s) => [s.key, s]));
      expect(byId.get('alert-eval-nightly')?.pattern).toBe('0 23 * * *');
      expect(byId.get('alert-eval-catchup')?.pattern).toBe('0 8 * * *');
      expect(byId.get('alert-eval-intraday')?.pattern).toBe('*/5 * * * *');
      for (const s of schedulers) expect(s.tz).toBe('Asia/Shanghai');
    } finally {
      await evalQueue.queue.close();
    }
  });

  /** dispatch 入队 stub (022 T006 双轨断言面; enqueueNow 可注入抛错)。 */
  function dispatchQueueStub(opts: { fail?: boolean } = {}): {
    stub: PushDispatchQueue;
    enqueued: string[];
  } {
    const enqueued: string[] = [];
    const stub = {
      enqueueNow: async (triggeredBy: string) => {
        if (opts.fail) throw new Error('redis down');
        enqueued.push(triggeredBy);
      },
    } as unknown as PushDispatchQueue;
    return { stub, enqueued };
  }

  it('processor 委托 UC: process() → execute() 一次返 summary + 即时 enqueue push-dispatch (D5)', async () => {
    let calls = 0;
    const uc = {
      execute: async () => {
        calls += 1;
        return summaryStub;
      },
    } as unknown as EvaluateAlertsUseCase;
    const { stub, enqueued } = dispatchQueueStub();
    const { stub: intraday, calls: intradayCalls } = intradayProcessorStub();
    const worker = new AlertEvalWorker(connection, uc, stub, intraday);

    const result = await worker.process({
      name: 'eval',
      data: { triggeredBy: 'cron' },
    } as Job<AlertEvalJobPayload>);
    expect(calls).toBe(1);
    expect(result).toEqual(summaryStub);
    expect(enqueued).toEqual(['eval']);
    expect(intradayCalls()).toBe(0); // EOD payload 不走盘中路由
  });

  it('intraday-cron payload → 委托 IntradayEvalProcessor, 不跑 EOD UC / 不 enqueue dispatch (024 T008 路由)', async () => {
    let evalCalls = 0;
    const uc = {
      execute: async () => {
        evalCalls += 1;
        return summaryStub;
      },
    } as unknown as EvaluateAlertsUseCase;
    const { stub, enqueued } = dispatchQueueStub();
    const { stub: intraday, calls: intradayCalls } = intradayProcessorStub();
    const worker = new AlertEvalWorker(connection, uc, stub, intraday);

    const result = await worker.process({
      name: 'eval',
      data: { triggeredBy: 'intraday-cron' },
    } as Job<AlertEvalJobPayload>);
    expect(intradayCalls()).toBe(1);
    expect(result).toEqual({ status: 'skipped-session' });
    expect(evalCalls).toBe(0); // 盘中 tick 不触发 EOD 全量轮
    expect(enqueued).toEqual([]); // 盘中触发的 dispatch 在 UC 内 (022 fan-out), 非此处
  });

  it('dispatch enqueue best-effort: 入队炸 → 评估轮 summary 照常返回 (sweep 兜底)', async () => {
    const uc = { execute: async () => summaryStub } as unknown as EvaluateAlertsUseCase;
    const { stub } = dispatchQueueStub({ fail: true });
    const { stub: intraday } = intradayProcessorStub();
    const worker = new AlertEvalWorker(connection, uc, stub, intraday);

    const result = await worker.process({
      name: 'eval',
      data: { triggeredBy: 'cron' },
    } as Job<AlertEvalJobPayload>);
    expect(result).toEqual(summaryStub);
  });

  it('sentinel 启停门: ALERT_WORKER_DISABLED 或 MARKETDATA_WORKER_DISABLED 置位 → worker 不启动', async () => {
    const uc = { execute: async () => summaryStub } as unknown as EvaluateAlertsUseCase;
    const { stub } = dispatchQueueStub();
    const { stub: intraday } = intradayProcessorStub();

    process.env[ALERT_WORKER_DISABLED] = '1';
    const gatedOwn = new AlertEvalWorker(connection, uc, stub, intraday);
    await gatedOwn.onModuleInit();
    expect(gatedOwn.running).toBe(false);

    delete process.env[ALERT_WORKER_DISABLED];
    process.env['MARKETDATA_WORKER_DISABLED'] = '1'; // marketdata CLI 进程在场 → alert 同不消费
    const gatedForeign = new AlertEvalWorker(connection, uc, stub, intraday);
    await gatedForeign.onModuleInit();
    expect(gatedForeign.running).toBe(false);
  });

  it('queue 常量形态 (T013 IT / CLI 共用锚)', () => {
    expect(ALERT_EVAL_QUEUE).toBe('alert-eval');
  });
});
