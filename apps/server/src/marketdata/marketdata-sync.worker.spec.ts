import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import type { MarketdataSyncConfig } from '../config/marketdata.config.js';
import { COLD_START_OUTCOME } from './anchor-cold-start.rules.js';
import type { AnchorColdStartUseCase, ColdStartResult } from './anchor-cold-start.usecase.js';
import type { DimensionExecutorRegistry } from './dimension-executor.js';
import {
  ANCHOR_COLD_START_JOB,
  ANCHOR_COLD_START_RETRY_MAX,
  MARKETDATA_SYNC_QUEUE,
  MarketdataSyncQueue,
  type AnchorColdStartJobPayload,
  type DimensionJobPayload,
  type MarketdataSyncJobPayload,
} from './marketdata-sync.queue.js';
import { MarketdataSyncWorker } from './marketdata-sync.worker.js';
import { emptyStats } from './sync-run.recorder.js';

const REQUEUE_DELAY_MS = 1_800_000;

const CFG = {
  requeueDelayMs: REQUEUE_DELAY_MS,
  removeOnCompleteCount: 200,
  removeOnFailCount: 100,
} as MarketdataSyncConfig;

const COLD_START_PAYLOAD: AnchorColdStartJobPayload = { ticker: 'us:AAPL', anchorId: '42' };

const DIMENSION_PAYLOAD: DimensionJobPayload = {
  dimensionKey: 'us_equity_bar',
  mode: 'delta',
  asOf: '2026-08-14',
  triggeredBy: 'tick',
};

/**
 * 真 `MarketdataSyncQueue` 原型 + 假 `queue` —— 入队 helper 走的是**被测的真实现**
 * (`enqueueColdStart` / `enqueueDimensionJob` / `jobOpts`), 只把最外层 bullmq 调用换成 spy。
 *
 * 这样「谁另起了一条队列」是可观测的: 新 `new Queue(...)` 不会落到这个 `add` 上 ⇒ 断言直接红。
 */
function buildQueue() {
  const add = vi.fn(async (name: string, data: unknown, opts: unknown) => ({ name, data, opts }));
  const getJob = vi.fn(async (_id: string): Promise<unknown> => undefined);
  const queue = { name: MARKETDATA_SYNC_QUEUE, add, getJob };
  const instance = Object.create(MarketdataSyncQueue.prototype) as MarketdataSyncQueue;
  Object.assign(instance, { queue, cfg: CFG });
  return { instance, add, getJob };
}

function build(
  overrides: {
    coldStartResult?: ColdStartResult;
    budgetExhausted?: boolean;
  } = {},
) {
  const { instance: syncQueue, add, getJob } = buildQueue();

  const execute = vi.fn(async (_key: string, _opts: unknown, _jobId?: string) => ({
    stats: { ...emptyStats(), ok: 3 },
    budgetExhausted: overrides.budgetExhausted === true,
  }));
  const executors = { execute } as unknown as DimensionExecutorRegistry;

  const run = vi.fn(
    async (_input: unknown): Promise<ColdStartResult> =>
      overrides.coldStartResult ?? { settled: true, outcome: COLD_START_OUTCOME.BACKFILLED },
  );
  const recordRetryExhausted = vi.fn(async (_input: unknown) => undefined);
  const coldStart = { run, recordRetryExhausted } as unknown as AnchorColdStartUseCase;

  const worker = new MarketdataSyncWorker({} as never, executors, syncQueue, coldStart, CFG);
  // `onJobFailed` 的降级出口是 WARN —— 断言它**没被调**才能区分「守卫早退」与「撞了异常被
  // catch 吞掉」, 两者的可观测面（recordRetryExhausted 零调用）本来一模一样。
  const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  return { worker, execute, run, recordRetryExhausted, add, getJob, warn };
}

function coldStartJob(
  data: AnchorColdStartJobPayload,
  attempts = ANCHOR_COLD_START_RETRY_MAX,
): Job<MarketdataSyncJobPayload> {
  return {
    id: 'cs-1',
    name: ANCHOR_COLD_START_JOB,
    data,
    opts: { attempts },
  } as unknown as Job<MarketdataSyncJobPayload>;
}

function dimensionJob(
  data: DimensionJobPayload,
  name = `sync:${data.dimensionKey}`,
): Job<MarketdataSyncJobPayload> {
  return {
    id: 'dim-1',
    name,
    data,
    opts: { attempts: 5 },
  } as unknown as Job<MarketdataSyncJobPayload>;
}

// build() 里挂了 Logger.prototype 的 spy —— 逐例复位, 免得跨 describe 泄漏计数。
beforeEach(() => {
  vi.restoreAllMocks();
});

describe('MarketdataSyncWorker — 冷启动路由 (060 T007)', () => {
  it('`sync:anchor-cold-start` 走冷启动 use case, **不**进 DimensionExecutorRegistry', async () => {
    const { worker, execute, run } = build();

    const result = await worker.process(coldStartJob(COLD_START_PAYLOAD));

    expect(execute).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
    const input = run.mock.calls[0]?.[0] as {
      anchorId: bigint;
      ticker: string;
      now: Date;
      phase?: string;
    };
    // anchorId 过 job payload 时是字符串 (BigInt 不可 JSON 序列化), 进 use case 必须还原成 bigint
    // —— 传字符串的话 Prisma 的 PK 匹配会静默错行。
    expect(input.anchorId).toBe(42n);
    expect(input.ticker).toBe('us:AAPL');
    expect(input.now).toBeInstanceOf(Date);
    expect(input.phase).toBeUndefined();
    expect(result).toEqual({ settled: true, outcome: COLD_START_OUTCOME.BACKFILLED });
  });

  it('第二相 `phase: snapshot` 原样透传 (flow parent 靠它跑敏感档)', async () => {
    const { worker, run } = build({
      coldStartResult: { settled: true, outcome: COLD_START_OUTCOME.INTRADAY_SKIPPED },
    });

    await worker.process(coldStartJob({ ...COLD_START_PAYLOAD, phase: 'snapshot' }));

    expect((run.mock.calls[0]?.[0] as { phase?: string }).phase).toBe('snapshot');
  });

  it('配额顺延 (`vendor_budget`) ⇒ 延时重入队同 payload, 不抛不耗 attempts', async () => {
    const { worker, add } = build({
      coldStartResult: { settled: false, deferral: 'vendor_budget' },
    });

    await expect(
      worker.process(coldStartJob({ ...COLD_START_PAYLOAD, phase: 'snapshot' })),
    ).resolves.toEqual({ settled: false, deferral: 'vendor_budget' });

    expect(add).toHaveBeenCalledTimes(1);
    const [name, data, opts] = add.mock.calls[0] as [string, unknown, { delay?: number }];
    expect(name).toBe(ANCHOR_COLD_START_JOB);
    // 原样重入队: 丢了 phase 就会从第一相重跑 ⇒ 再组一棵 flow ⇒ 链/日线被重复拉一遍。
    expect(data).toEqual({ ...COLD_START_PAYLOAD, phase: 'snapshot' });
    expect(opts.delay).toBe(REQUEUE_DELAY_MS);
  });

  it('第一相交回 `awaiting_chain` ⇒ 零重入队 (第二相由 flow parent 语义接管)', async () => {
    const { worker, add } = build({
      coldStartResult: { settled: false, deferral: 'awaiting_chain' },
    });

    await worker.process(coldStartJob(COLD_START_PAYLOAD));

    expect(add).not.toHaveBeenCalled();
  });

  it('payload 漂移 (anchorId 非十进制串) ⇒ 直接 fail, use case 零调用', async () => {
    const { worker, run } = build();

    await expect(
      worker.process(coldStartJob({ ticker: 'us:AAPL', anchorId: 'not-a-number' })),
    ).rejects.toThrow(/payload/);
    expect(run).not.toHaveBeenCalled();
  });

  it('payload 漂移 (ticker 空串) ⇒ 直接 fail, use case 零调用', async () => {
    const { worker, run } = build();

    await expect(worker.process(coldStartJob({ ticker: '', anchorId: '42' }))).rejects.toThrow(
      /payload/,
    );
    expect(run).not.toHaveBeenCalled();
  });
});

describe('MarketdataSyncWorker — 既有维度路由回归', () => {
  it('`sync:<dim>` 仍路由 executor, 冷启动 use case 零调用', async () => {
    const { worker, execute, run } = build();

    const stats = await worker.process(dimensionJob(DIMENSION_PAYLOAD));

    expect(run).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
    const [key, opts, jobId] = execute.mock.calls[0] as [string, Record<string, unknown>, string];
    expect(key).toBe('us_equity_bar');
    expect(opts.mode).toBe('delta');
    expect(opts.asOf).toBe('2026-08-14');
    expect(jobId).toBe('dim-1');
    expect(stats).toEqual({ ...emptyStats(), ok: 3 });
  });

  it('job.name 与 payload dimensionKey 漂移 ⇒ 仍抛 (不路由错维度)', async () => {
    const { worker, execute } = build();

    await expect(
      worker.process(dimensionJob(DIMENSION_PAYLOAD, 'sync:option_contract')),
    ).rejects.toThrow(/不一致/);
    expect(execute).not.toHaveBeenCalled();
  });

  it('维度配额耗尽 ⇒ 仍顺延重入队同维度 job', async () => {
    const { worker, add } = build({ budgetExhausted: true });

    await worker.process(dimensionJob(DIMENSION_PAYLOAD));

    expect(add).toHaveBeenCalledTimes(1);
    const [name, data, opts] = add.mock.calls[0] as [string, unknown, { delay?: number }];
    expect(name).toBe('sync:us_equity_bar');
    expect(data).toEqual(DIMENSION_PAYLOAD);
    expect(opts.delay).toBe(REQUEUE_DELAY_MS);
  });
});

describe('MarketdataSyncWorker — retry 耗尽出口 (FR-019a)', () => {
  it('冷启动 job 硬失败 ⇒ 落 `retry_exhausted`', async () => {
    const { worker, recordRetryExhausted, getJob } = build();
    getJob.mockResolvedValue(coldStartJob({ ...COLD_START_PAYLOAD, phase: 'snapshot' }));

    await worker.onJobFailed('cs-1', 'boom');

    expect(recordRetryExhausted).toHaveBeenCalledTimes(1);
    expect(recordRetryExhausted.mock.calls[0]?.[0]).toMatchObject({
      anchorId: 42n,
      ticker: 'us:AAPL',
    });
  });

  it('维度 job 硬失败 ⇒ **不**碰冷启动运行记录 (路由键是 job.name, 不是 payload 长相)', async () => {
    const { worker, recordRetryExhausted, getJob, warn } = build();
    // 🚨 蓄意给一个「长得像冷启动」的 payload: 谁把判据从 `job.name` 换成 payload 探嗅,
    //    这条立刻红。喂纯维度 payload 的话, 无守卫版本会撞 `BigInt(undefined)` 抛错被 catch
    //    吞掉 —— 观测面同样是「零调用」⇒ 那样写出来的是一条恒真绿。
    getJob.mockResolvedValue({
      ...dimensionJob(DIMENSION_PAYLOAD),
      data: { ...DIMENSION_PAYLOAD, ticker: 'us:MSFT', anchorId: '99' },
    });

    await worker.onJobFailed('dim-1', 'boom');

    expect(recordRetryExhausted).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('job 已被 removeOnFail 清掉 ⇒ 静默略过, 不抛 (事件监听里抛 = unhandled rejection)', async () => {
    const { worker, recordRetryExhausted, getJob, warn } = build();
    getJob.mockResolvedValue(undefined);

    await expect(worker.onJobFailed('gone-1', 'boom')).resolves.toBeUndefined();
    expect(recordRetryExhausted).not.toHaveBeenCalled();
    // 走的必须是 undefined 守卫的**早退**, 而不是 `job.name` 上撞 TypeError 被 catch 兜住。
    expect(warn).not.toHaveBeenCalled();
  });

  it('落库失败 ⇒ 降级 WARN, **不**抛 (事件监听里抛 = unhandled rejection)', async () => {
    const { worker, recordRetryExhausted, getJob, warn } = build();
    getJob.mockResolvedValue(coldStartJob(COLD_START_PAYLOAD));
    recordRetryExhausted.mockRejectedValue(new Error('PG down'));

    await expect(worker.onJobFailed('cs-1', 'boom')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('MarketdataSyncQueue.enqueueColdStart — 单队列铁律 (Guardrail 6)', () => {
  it('入队走构造器绑定的那一个 `marketdata-sync` 队列, job 名 + attempts 按冷启动语义', async () => {
    const { instance, add } = buildQueue();

    await instance.enqueueColdStart(COLD_START_PAYLOAD);

    // 🚨 另起一条队列的话这个 spy 一次都不会被调到 —— 这条断言守的就是那件事 (plan §D3:
    //    另起队列 = 冷启动与夜间批并发打 vendor, 直接撞限频)。
    expect(add).toHaveBeenCalledTimes(1);
    const [name, data, opts] = add.mock.calls[0] as [
      string,
      unknown,
      { attempts: number; backoff: unknown; delay?: number },
    ];
    expect(name).toBe(ANCHOR_COLD_START_JOB);
    expect(data).toEqual(COLD_START_PAYLOAD);
    expect(opts.attempts).toBe(ANCHOR_COLD_START_RETRY_MAX);
    expect(opts.backoff).toEqual({ type: 'exponential', delay: 60_000 });
    expect(opts.delay).toBeUndefined();
  });

  it('`delayMs` 透传 (配额顺延复用同一入口)', async () => {
    const { instance, add } = buildQueue();

    await instance.enqueueColdStart(COLD_START_PAYLOAD, { delayMs: REQUEUE_DELAY_MS });

    const [, , opts] = add.mock.calls[0] as [string, unknown, { delay?: number }];
    expect(opts.delay).toBe(REQUEUE_DELAY_MS);
  });
});
