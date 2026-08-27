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
  DEFAULT_QUEUE_LANE,
  MARKETDATA_SYNC_FUTU_QUEUE,
  MARKETDATA_SYNC_QUEUE,
  MarketdataSyncQueue,
  type AnchorColdStartJobPayload,
  type DimensionJobPayload,
  type MarketdataSyncJobPayload,
} from './marketdata-sync.queue.js';
import { MarketdataSyncWorker } from './marketdata-sync.worker.js';
import { INTERRUPT_REASON, emptyStats, type SyncRunRecorder } from './sync-run.recorder.js';

const REQUEUE_DELAY_MS = 1_800_000;

const CFG = {
  requeueDelayMs: REQUEUE_DELAY_MS,
  removeOnCompleteCount: 200,
  removeOnFailCount: 100,
  // 灰度关 ⇒ `resolveLane` 恒返 default、`activeLanes()` 只含 default (#210)。
  futuLaneEnabled: false,
} as MarketdataSyncConfig;

const COLD_START_PAYLOAD: AnchorColdStartJobPayload = { ticker: 'us:AAPL', anchorId: '42' };

const DIMENSION_PAYLOAD: DimensionJobPayload = {
  dimensionKey: 'us_equity_bar',
  mode: 'delta',
  asOf: '2026-08-14',
  triggeredBy: 'tick',
};

/**
 * 真 `MarketdataSyncQueue` 原型 + 假 queue —— 入队 helper 走的是**被测的真实现**
 * (`enqueueColdStart` / `enqueueDimensionJob` / `jobOpts`), 只把最外层 bullmq 调用换成 spy。
 *
 * 这样「谁另起了一条队列」仍然可观测, 且 #210 后**更严**: 只给 `default` lane 塞了假 queue,
 * 任何走到别的 lane 的路径都会让 `queueFor()` 去 `new Queue(...)` 真连 Redis (connection
 * 未注入) ⇒ 当场炸, 而不是悄悄落到这个 `add` 上。
 */
function buildQueue(opts: { futuLaneEnabled?: boolean } = {}) {
  const mk = (name: string) => {
    const add = vi.fn(async (n: string, data: unknown, o: unknown) => ({ name: n, data, opts: o }));
    const getJob = vi.fn(async (_id: string): Promise<unknown> => undefined);
    return { queue: { name, add, getJob }, add, getJob };
  };
  const def = mk(MARKETDATA_SYNC_QUEUE);
  const futu = mk(MARKETDATA_SYNC_FUTU_QUEUE);
  const queues = new Map<string, unknown>([[DEFAULT_QUEUE_LANE, def.queue]]);
  // 灰度关时**不**塞 futu —— 走到它就会去 new Queue(...) 真连 Redis 而当场炸 (见上注释)。
  if (opts.futuLaneEnabled === true) queues.set('futu', futu.queue);
  const instance = Object.create(MarketdataSyncQueue.prototype) as MarketdataSyncQueue;
  Object.assign(instance, {
    queues,
    cfg: { ...CFG, futuLaneEnabled: opts.futuLaneEnabled === true },
  });
  return { instance, add: def.add, getJob: def.getJob, futuAdd: futu.add };
}

function build(
  overrides: {
    coldStartResult?: ColdStartResult;
    budgetExhausted?: boolean;
    convergeThrows?: boolean;
    convergedRows?: number;
  } = {},
) {
  const { instance: syncQueue, add, getJob } = buildQueue();

  // #137: 收敛与执行的**先后**是本机制的正确性依据 (收敛必须早于新行 INSERT), 而两个 spy
  // 各自的 mock.calls 看不出跨 spy 的顺序 ⇒ 记一条共同时间线。
  const order: string[] = [];

  const execute = vi.fn(
    async (
      _key: string,
      _opts: unknown,
      _origin?: { bullJobId?: string; triggeredBy?: string },
    ) => {
      order.push('execute');
      return {
        stats: { ...emptyStats(), ok: 3 },
        budgetExhausted: overrides.budgetExhausted === true,
      };
    },
  );
  const executors = { execute } as unknown as DimensionExecutorRegistry;

  const convergeInterrupted = vi.fn(async (_jobId: string, _reason: string, _now?: Date) => {
    order.push('converge');
    if (overrides.convergeThrows === true) throw new Error('DB down');
    return overrides.convergedRows ?? 0;
  });
  const runRecorder = { convergeInterrupted } as unknown as SyncRunRecorder;

  const run = vi.fn(
    async (_input: unknown): Promise<ColdStartResult> =>
      overrides.coldStartResult ?? { settled: true, outcome: COLD_START_OUTCOME.BACKFILLED },
  );
  const recordRetryExhausted = vi.fn(async (_input: unknown) => undefined);
  const coldStart = { run, recordRetryExhausted } as unknown as AnchorColdStartUseCase;

  const worker = new MarketdataSyncWorker(
    {} as never,
    executors,
    syncQueue,
    coldStart,
    CFG,
    runRecorder,
  );
  // `onJobFailed` 的降级出口是 WARN —— 断言它**没被调**才能区分「守卫早退」与「撞了异常被
  // catch 吞掉」, 两者的可观测面（recordRetryExhausted 零调用）本来一模一样。
  const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  return {
    worker,
    execute,
    run,
    recordRetryExhausted,
    add,
    getJob,
    warn,
    convergeInterrupted,
    order,
  };
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
    expect(result).toEqual({ settled: true, outcome: COLD_START_OUTCOME.BACKFILLED });
  });

  it('配额顺延 (`vendor_budget`) ⇒ 延时重入队同 payload, 不抛不耗 attempts', async () => {
    const { worker, add } = build({
      coldStartResult: { settled: false, deferral: 'vendor_budget' },
    });

    await expect(worker.process(coldStartJob(COLD_START_PAYLOAD))).resolves.toEqual({
      settled: false,
      deferral: 'vendor_budget',
    });

    expect(add).toHaveBeenCalledTimes(1);
    const [name, data, opts] = add.mock.calls[0] as [string, unknown, { delay?: number }];
    expect(name).toBe(ANCHOR_COLD_START_JOB);
    // 原样重入队 (issue #159 后 payload 只剩 ticker + anchorId, 两相已合一)。
    expect(data).toEqual(COLD_START_PAYLOAD);
    expect(opts.delay).toBe(REQUEUE_DELAY_MS);
  });

  it('终结结局 ⇒ 零重入队 (只有 vendor_budget 顺延才重投)', async () => {
    // issue #159 前这里验的是 `awaiting_chain`(第一相组完 flow 交回、不重投)。两相合一后
    // 该 deferral 退役, 剩下唯一的「不重投」情形就是已终结。
    const { worker, add } = build({
      coldStartResult: { settled: true, outcome: COLD_START_OUTCOME.BACKFILLED },
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
    const [key, opts, origin] = execute.mock.calls[0] as [
      string,
      Record<string, unknown>,
      { bullJobId?: string; triggeredBy?: string },
    ];
    expect(key).toBe('us_equity_bar');
    expect(opts.mode).toBe('delta');
    expect(opts.asOf).toBe('2026-08-14');
    expect(origin.bullJobId).toBe('dim-1');
    // #202: 触发源逐字来自 payload —— worker 不许在这里兜底, 否则任何漏传的入队路径都会
    // 冒充成一轮按计划执行的 tick 轮, 而「连续 N 轮」的计数器正是吃这一列。
    expect(origin.triggeredBy).toBe('tick');
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
    // #202: **除 triggeredBy 外**原样 —— 顺延跑出来的是同一轮的重入, 它会开出第二行 sync_run;
    // 继续标 'tick' 就等于把一轮数成两轮, 一次配额耗尽凭空吃掉一格阈值预算。
    expect(data).toEqual({ ...DIMENSION_PAYLOAD, triggeredBy: 'requeue' });
    expect(opts.delay).toBe(REQUEUE_DELAY_MS);
  });
});

describe('MarketdataSyncWorker — retry 耗尽出口 (FR-019a)', () => {
  it('冷启动 job 硬失败 ⇒ 落 `retry_exhausted`', async () => {
    const { worker, recordRetryExhausted, getJob } = build();
    getJob.mockResolvedValue(coldStartJob(COLD_START_PAYLOAD));

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

describe('MarketdataSyncWorker — 打断收敛 (#137)', () => {
  it('触发点 A: 维度 job 开工前先收敛同 job 的僵尸行, **且早于 execute**', async () => {
    const { worker, convergeInterrupted, order } = build();

    await worker.process(dimensionJob(DIMENSION_PAYLOAD));

    expect(convergeInterrupted).toHaveBeenCalledWith('dim-1', INTERRUPT_REASON.SUPERSEDED_BY_RETRY);
    // 🚨 顺序即正确性: execute() 起手就 recorder.start() 开新行, 收敛跑在它之后就会把自己
    //    刚开的那一行当僵尸收掉 —— 而那是**静默**的错 (两行都在, 状态却反了)。
    expect(order).toEqual(['converge', 'execute']);
  });

  it('触发点 A 失败 ⇒ 降级 WARN 但**本轮同步照跑** (审计行没收干净不该废掉整轮活)', async () => {
    const { worker, execute, warn } = build({ convergeThrows: true });

    await expect(worker.process(dimensionJob(DIMENSION_PAYLOAD))).resolves.toMatchObject({ ok: 3 });

    expect(execute).toHaveBeenCalledTimes(1);
    // 降级必须**有声** —— 这个机制自己坏掉且没有声音, 正是 #137 / #103 同族问题的病根。
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('冷启动 job **不**走触发点 A (它不落 sync_run 行, 没有可收的东西)', async () => {
    const { worker, convergeInterrupted } = build();

    await worker.process(coldStartJob(COLD_START_PAYLOAD));

    expect(convergeInterrupted).not.toHaveBeenCalled();
  });

  it('触发点 B: retry 耗尽 ⇒ 收敛且 reason 是「不会再重跑」那一条', async () => {
    const { worker, convergeInterrupted, getJob } = build();
    getJob.mockResolvedValue(dimensionJob(DIMENSION_PAYLOAD));

    await worker.onJobFailed('dim-1', 'boom');

    // 🚨 必须跑在 `getJob` 的冷启动早退**之前** —— 维度 job 正是要收的那一类, 放在早退之后
    //    等于对全部维度 job 无效, 而它照样绿。
    expect(convergeInterrupted).toHaveBeenCalledWith('dim-1', INTERRUPT_REASON.RETRIES_EXHAUSTED);
  });

  it('触发点 B: job 已被 removeOnFail 清掉也照收 (行在 PG 里, 与 Redis 还留不留 job 无关)', async () => {
    const { worker, convergeInterrupted, getJob } = build();
    getJob.mockResolvedValue(undefined);

    await worker.onJobFailed('gone-1', 'boom');

    expect(convergeInterrupted).toHaveBeenCalledWith('gone-1', INTERRUPT_REASON.RETRIES_EXHAUSTED);
  });

  it('触发点 B 失败 ⇒ 不抛 (事件监听里抛 = unhandled rejection)', async () => {
    const { worker, warn } = build({ convergeThrows: true });

    await expect(worker.onJobFailed('dim-1', 'boom')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('MarketdataSyncQueue.enqueueColdStart — lane 归属 (原 Guardrail 6)', () => {
  // 🚨 **本组的判据在 #210 变了, 别照着旧名字改回去。**
  //   旧名是「单队列铁律」, 理由写的是「另起队列 = 冷启动与夜间批并发打 vendor 直接撞限频」。
  //   那个理由**已被证伪**: 限频的 enforcer 是传输层单例令牌桶 (每个 VendorHttpClient 单例,
  //   futu 按 capability 拆 5 个, acquire() 用 tail promise 链把并发调用 FIFO 排队) ——
  //   并发几条 lane 都撞不了限频。而把冷启动压在理杏仁 2h35m 长链后面是有实测代价的:
  //   22:00 后建锚会被推过午夜, 「黄金窗口」只剩交易日 21:30-21:59。
  //   ⇒ 现在的判据是**lane 归属**: 灰度关 → default (行为不变); 灰度开 → futu。
  it('灰度关: 仍落 default lane, job 名 + attempts 按冷启动语义', async () => {
    const { instance, add, futuAdd } = buildQueue();

    await instance.enqueueColdStart(COLD_START_PAYLOAD);

    expect(add).toHaveBeenCalledTimes(1);
    expect(futuAdd).not.toHaveBeenCalled();
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

  it('灰度开: 落 futu lane (冷启动打的就是 futu 的链发现与快照)', async () => {
    const { instance, add, futuAdd } = buildQueue({ futuLaneEnabled: true });

    await instance.enqueueColdStart(COLD_START_PAYLOAD);

    expect(futuAdd).toHaveBeenCalledTimes(1);
    expect(add).not.toHaveBeenCalled();
    expect(futuAdd.mock.calls[0]?.[0]).toBe(ANCHOR_COLD_START_JOB);
  });

  it('`delayMs` 透传 (配额顺延复用同一入口)', async () => {
    const { instance, add } = buildQueue();

    await instance.enqueueColdStart(COLD_START_PAYLOAD, { delayMs: REQUEUE_DELAY_MS });

    const [, , opts] = add.mock.calls[0] as [string, unknown, { delay?: number }];
    expect(opts.delay).toBe(REQUEUE_DELAY_MS);
  });
});
