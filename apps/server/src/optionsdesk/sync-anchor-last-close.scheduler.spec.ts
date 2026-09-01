import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { MarketdataConfig } from '../config/marketdata.config';
import type {
  SyncAnchorLastCloseReport,
  SyncAnchorLastCloseUseCase,
} from './sync-anchor-last-close';
import {
  LAST_CLOSE_TICK_CRON,
  LAST_CLOSE_TICK_INTERVAL_MINUTES,
  SyncAnchorLastCloseScheduler,
} from './sync-anchor-last-close.scheduler';

type Fn = ReturnType<typeof vi.fn>;

const NOW = new Date('2026-09-01T08:30:00Z');

const reportOf = (over: Partial<SyncAnchorLastCloseReport> = {}): SyncAnchorLastCloseReport => ({
  markets: [],
  scanned: 1,
  updated: 1,
  sourceFailures: 0,
  sourceSuccesses: 1,
  unsupportedMarkets: [],
  ...over,
});

interface Harness {
  scheduler: SyncAnchorLastCloseScheduler;
  execute: Fn;
}

function build(kind: MarketdataConfig['kind'] = 'live'): Harness {
  const execute = vi.fn().mockResolvedValue(reportOf());
  const scheduler = new SyncAnchorLastCloseScheduler(
    { execute } as unknown as SyncAnchorLastCloseUseCase,
    { kind } as MarketdataConfig,
  );
  return { scheduler, execute };
}

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('SyncAnchorLastCloseScheduler', () => {
  it('🚨 mock 档: **0 次 use case 调用** (Guardrail 6 第一层, dev 机完全静默)', async () => {
    const h = build('mock');

    await expect(h.scheduler.run(NOW)).resolves.toEqual({ status: 'skipped-mock' });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('live 档: 透传 use case 的报告, 且把注入的时钟原样交下去', async () => {
    const h = build();

    const outcome = await h.scheduler.run(NOW);

    expect(outcome).toEqual({ status: 'ticked', report: reportOf() });
    expect(h.execute).toHaveBeenCalledWith(NOW);
  });

  it('🚨 use case 抛 ⇒ 落 failed 且**不上抛** (scheduler 抛 = 进程级 unhandledRejection)', async () => {
    const h = build();
    h.execute.mockRejectedValueOnce(new Error('库挂了'));

    await expect(h.scheduler.run(NOW)).resolves.toEqual({
      status: 'failed',
      reason: '库挂了',
    });
  });

  it('🚨 cron 由间隔常量**派生**, 不写第二份 10', () => {
    expect(LAST_CLOSE_TICK_CRON).toBe(`0 */${LAST_CLOSE_TICK_INTERVAL_MINUTES} * * * *`);
    // 6 段秒级 cron —— 段数写错会让 @nestjs/schedule 按分钟级解析, 静默改变触发频率。
    expect(LAST_CLOSE_TICK_CRON.split(' ')).toHaveLength(6);
  });
});
