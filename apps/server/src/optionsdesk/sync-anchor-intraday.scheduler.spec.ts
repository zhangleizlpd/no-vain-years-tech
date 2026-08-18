import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { MarketdataConfig } from '../config/marketdata.config';
import type { MarketSession } from '../marketdata/market-state.port';
import { INTRADAY_CIRCUIT_THRESHOLD, INTRADAY_TICK_INTERVAL_SECONDS } from './intraday-spot.rules';
import type { SyncAnchorIntradayReport, SyncAnchorIntradayUseCase } from './sync-anchor-intraday';
import {
  INTRADAY_CIRCUIT_KEY,
  INTRADAY_FAILSTREAK_KEY,
  INTRADAY_LAST_SESSIONS_KEY,
  INTRADAY_TICK_CRON,
  SyncAnchorIntradayScheduler,
} from './sync-anchor-intraday.scheduler';

type Fn = ReturnType<typeof vi.fn>;

/** 各分支的报告样板 —— tick 的三段闸判在 use case 内, scheduler 只据报告裁决熔断。 */
const reportOf = (over: Partial<SyncAnchorIntradayReport> = {}): SyncAnchorIntradayReport => ({
  sessions: { us: 'regular' },
  markets: [],
  sourceFailures: 0,
  sourceSuccesses: 1,
  unsupportedMarkets: [],
  scanned: 1,
  updated: 1,
  ...over,
});

/** 采集全断的一拍 (源故障)。 */
const failedReport = () => reportOf({ sourceSuccesses: 0, sourceFailures: 1 });

/** 一次源调用都没发生的一拍 (闸挡下 / 全是无路由市场)。 */
const noAttemptReport = (over: Partial<SyncAnchorIntradayReport> = {}) =>
  reportOf({ sourceSuccesses: 0, sourceFailures: 0, updated: 0, ...over });

interface RedisFake {
  redis: Redis;
  store: Map<string, string>;
  get: Fn;
  set: Fn;
  incr: Fn;
}

function buildRedis(seed: Record<string, string> = {}): RedisFake {
  const store = new Map<string, string>(Object.entries(seed));
  const get = vi.fn((k: string) => Promise.resolve(store.get(k) ?? null));
  const set = vi.fn((k: string, v: string) => {
    store.set(k, String(v));
    return Promise.resolve('OK');
  });
  const incr = vi.fn((k: string) => {
    const next = Number(store.get(k) ?? '0') + 1;
    store.set(k, String(next));
    return Promise.resolve(next);
  });
  return { redis: { get, set, incr } as unknown as Redis, store, get, set, incr };
}

interface Harness {
  scheduler: SyncAnchorIntradayScheduler;
  execute: Fn;
  r: RedisFake;
}

function build(
  reports: (SyncAnchorIntradayReport | Error)[],
  opts: { kind?: 'mock' | 'live'; seed?: Record<string, string> } = {},
): Harness {
  const queue = [...reports];
  const execute = vi.fn(() => {
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
  const r = buildRedis(opts.seed);
  const scheduler = new SyncAnchorIntradayScheduler(
    { execute } as unknown as SyncAnchorIntradayUseCase,
    r.redis,
    { kind: opts.kind ?? 'live' } as MarketdataConfig,
  );
  return { scheduler, execute, r };
}

describe('盘中 tick 的 Redis 命名空间 (plan D9)', () => {
  it('🚨 三个键都住 optionsdesk:intraday:*, MUST NOT 与 alert:intraday:* 共用', () => {
    for (const key of [INTRADAY_FAILSTREAK_KEY, INTRADAY_CIRCUIT_KEY, INTRADAY_LAST_SESSIONS_KEY]) {
      expect(key.startsWith('optionsdesk:intraday:')).toBe(true);
      expect(key.startsWith('alert:')).toBe(false);
    }
  });

  it('cron 表达式由 tick 间隔常量派生 (T 是唯一自由变量, Guardrail 10)', () => {
    expect(INTRADAY_TICK_CRON).toBe(`*/${INTRADAY_TICK_INTERVAL_SECONDS} * * * * *`);
  });
});

describe('SyncAnchorIntradayScheduler — tick 触发 + 熔断 + mock 闸 (FR-005/FR-012)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('🚨 mock 档 → skipped-mock, **0 次 port 调用、0 次 Redis 触碰** (Guardrail 6 第一层防线)', async () => {
    const { scheduler, execute, r } = build([reportOf()], { kind: 'mock' });

    await expect(scheduler.run()).resolves.toEqual({ status: 'skipped-mock' });

    expect(execute).not.toHaveBeenCalled();
    expect(r.get).not.toHaveBeenCalled();
    expect(r.set).not.toHaveBeenCalled();
  });

  it('采集成功 → verdict=success, failstreak 清零', async () => {
    const { scheduler, r } = build([reportOf()], { seed: { [INTRADAY_FAILSTREAK_KEY]: '2' } });

    const outcome = await scheduler.run();

    expect(outcome).toMatchObject({ status: 'ticked', verdict: 'success', failstreak: 0 });
    expect(r.store.get(INTRADAY_FAILSTREAK_KEY)).toBe('0');
  });

  it('连续失败 1 / 2 次 → failstreak 累加但 circuit 仍 closed', async () => {
    const { scheduler } = build([failedReport()]);

    const first = await scheduler.run();
    const second = await scheduler.run();

    expect(first).toMatchObject({ verdict: 'failure', failstreak: 1, circuit: 'closed' });
    expect(second).toMatchObject({ verdict: 'failure', failstreak: 2, circuit: 'closed' });
  });

  it(`连续失败 ${INTRADAY_CIRCUIT_THRESHOLD} 次 → circuit open + 降级留痕 (state_branch 9)`, async () => {
    const { scheduler, r } = build([failedReport()]);

    let outcome = await scheduler.run();
    for (let i = 1; i < INTRADAY_CIRCUIT_THRESHOLD; i += 1) outcome = await scheduler.run();

    expect(outcome).toMatchObject({ failstreak: INTRADAY_CIRCUIT_THRESHOLD, circuit: 'open' });
    expect(r.store.get(INTRADAY_CIRCUIT_KEY)).toBe('open');
    expect(warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join(' ')).toContain('open');
  });

  it('熔断后首次成功 → 自动回升 closed, 无需人工介入 (state_branch 10)', async () => {
    const { scheduler, r } = build([reportOf()], {
      seed: { [INTRADAY_CIRCUIT_KEY]: 'open', [INTRADAY_FAILSTREAK_KEY]: '5' },
    });

    const outcome = await scheduler.run();

    expect(outcome).toMatchObject({ verdict: 'success', circuit: 'closed', failstreak: 0 });
    expect(r.store.get(INTRADAY_CIRCUIT_KEY)).toBe('closed');
    expect(warnSpy).toHaveBeenCalledTimes(1); // 回升那条留痕
  });

  it('🚨 只有 hk 锚无路由 (us 全成功) 连跑 10 拍 → circuit 恒 closed (Guardrail 16 回归钉)', async () => {
    const { scheduler, r } = build([reportOf({ unsupportedMarkets: ['hk'] })]);

    for (let i = 0; i < 10; i += 1) {
      const outcome = await scheduler.run();
      expect(outcome).toMatchObject({ verdict: 'success', circuit: 'closed' });
    }
    expect(r.store.get(INTRADAY_CIRCUIT_KEY)).not.toBe('open');
  });

  it('🚨 库里**只有** hk 锚 (零源调用) 连跑 10 拍 → verdict=no-attempt, failstreak 一次都不加', async () => {
    const { scheduler, r } = build([noAttemptReport({ unsupportedMarkets: ['hk'] })]);

    for (let i = 0; i < 10; i += 1) {
      const outcome = await scheduler.run();
      expect(outcome).toMatchObject({ verdict: 'no-attempt', circuit: 'closed', failstreak: 0 });
    }
    expect(r.incr).not.toHaveBeenCalled();
    expect(r.store.get(INTRADAY_CIRCUIT_KEY)).not.toBe('open');
  });

  it('闸挡下的一拍 (非时段 / 非交易日) → no-attempt, 既不计失败也不清既有 failstreak', async () => {
    const { scheduler, r } = build([noAttemptReport()], {
      seed: { [INTRADAY_FAILSTREAK_KEY]: '2' },
    });

    const outcome = await scheduler.run();

    expect(outcome).toMatchObject({ verdict: 'no-attempt' });
    expect(r.store.get(INTRADAY_FAILSTREAK_KEY)).toBe('2');
  });

  it('收盘补一拍: 上一拍状态从 Redis 取出并喂给 use case, 本拍状态写回 (state_branch 6)', async () => {
    const previous: Record<string, MarketSession> = { us: 'regular' };
    const { scheduler, execute, r } = build([reportOf({ sessions: { us: 'other' } })], {
      seed: { [INTRADAY_LAST_SESSIONS_KEY]: JSON.stringify(previous) },
    });

    await scheduler.run();

    expect(execute.mock.calls[0]?.[1]).toEqual({ previousSessions: previous });
    // 本拍状态落库 ⇒ 下一拍的「上一拍」已不在白名单 ⇒ 不会再补第二次。
    expect(r.store.get(INTRADAY_LAST_SESSIONS_KEY)).toBe(JSON.stringify({ us: 'other' }));
  });

  it('连跑两拍: 第二拍拿到的「上一拍」正是第一拍观测到的状态 (再下一拍不补)', async () => {
    const { scheduler, execute } = build([
      reportOf({ sessions: { us: 'regular' } }),
      reportOf({ sessions: { us: 'other' } }),
      reportOf({ sessions: { us: 'other' } }),
    ]);

    await scheduler.run();
    await scheduler.run();
    await scheduler.run();

    expect(execute.mock.calls[1]?.[1]).toEqual({ previousSessions: { us: 'regular' } });
    expect(execute.mock.calls[2]?.[1]).toEqual({ previousSessions: { us: 'other' } });
  });

  it('🚨 状态不可得的一拍 → **不覆盖**上一拍状态 (否则收盘那个沿被一次源抖动吞掉)', async () => {
    const { scheduler, r } = build([{ ...failedReport(), sessions: null }], {
      seed: { [INTRADAY_LAST_SESSIONS_KEY]: JSON.stringify({ us: 'regular' }) },
    });

    await scheduler.run();

    expect(r.store.get(INTRADAY_LAST_SESSIONS_KEY)).toBe(JSON.stringify({ us: 'regular' }));
  });

  it('Redis 里的上一拍状态不可解析 → 当作没有 (不猜, 不抛)', async () => {
    const { scheduler, execute } = build([reportOf()], {
      seed: { [INTRADAY_LAST_SESSIONS_KEY]: 'not-json' },
    });

    await expect(scheduler.run()).resolves.toMatchObject({ status: 'ticked' });
    expect(execute.mock.calls[0]?.[1]).toEqual({ previousSessions: null });
  });

  it('🚨 use case 意外抛 → 只 ERROR log, **不上抛**、也不计源故障 (熔断只认行情源)', async () => {
    const { scheduler, r } = build([new Error('db down')]);

    await expect(scheduler.run()).resolves.toMatchObject({ status: 'failed', reason: 'db down' });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(r.incr).not.toHaveBeenCalled();
  });

  it('handleCron 委托给 run (cron 入口不另写逻辑)', async () => {
    const { scheduler, execute } = build([reportOf()]);

    await expect(scheduler.handleCron()).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
