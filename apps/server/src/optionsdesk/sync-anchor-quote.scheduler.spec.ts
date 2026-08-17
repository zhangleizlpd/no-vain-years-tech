import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { SyncAnchorQuoteScheduler } from './sync-anchor-quote.scheduler';
import {
  ANCHOR_QUOTE_PRICE_KIND,
  type AnchorQuoteProjection,
  type SyncAnchorQuoteReport,
  type SyncAnchorQuoteUseCase,
} from './sync-anchor-quote';

const withData = (ticker: string): AnchorQuoteProjection => ({
  ticker,
  lastClose: new Prisma.Decimal('36.5000'),
  asOf: '2026-07-31',
  priceKind: ANCHOR_QUOTE_PRICE_KIND,
  hasData: true,
});

const noData = (ticker: string): AnchorQuoteProjection => ({
  ticker,
  lastClose: null,
  asOf: null,
  priceKind: ANCHOR_QUOTE_PRICE_KIND,
  hasData: false,
});

function build(report: SyncAnchorQuoteReport | Error) {
  const execute = vi.fn(() =>
    report instanceof Error ? Promise.reject(report) : Promise.resolve(report),
  );
  const scheduler = new SyncAnchorQuoteScheduler({ execute } as unknown as SyncAnchorQuoteUseCase);
  return { scheduler, execute };
}

describe('SyncAnchorQuoteScheduler — 投影触发器 (补 045 T012 漏定义的调用方)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // `logger` 是实例字段、不在 scheduler 原型上 ⇒ 只能 spy Nest `Logger` 自身的原型。
    // mockImplementation 顺带把日志静音, 免污染测试输出。
    logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  // 🚨 必须显式还原: 仓内 vitest config **没有**配 `restoreMocks`/`clearMocks`, 而本组用例
  // 断言的是 `mock.calls[0]` —— 不还原则 spy 历史跨用例累积, 后面的用例会读到前面留下的那条
  // 调用而「通过」或「失败」得毫无道理 (本 spec 首轮就栽在这: 截断用例读到了上一例的 us:ACN)。
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('调用 use case 并原样回传 report', async () => {
    const report: SyncAnchorQuoteReport = {
      scanned: 2,
      updated: 2,
      projections: [withData('us:AOS'), withData('us:CPB')],
    };
    const { scheduler, execute } = build(report);

    await expect(scheduler.run()).resolves.toEqual(report);
    expect(execute).toHaveBeenCalledTimes(1);
    // 统计进日志 —— 没有它就无法事后确认「投影到底跑没跑、动了几行」。
    const msg = String(logSpy.mock.calls[0]?.[0]);
    expect(msg).toContain('"scanned":2');
    expect(msg).toContain('"updated":2');
    expect(msg).toContain('"noData":0');
  });

  it('全部有数 → 不发 no-data warn', async () => {
    const { scheduler } = build({ scanned: 1, updated: 1, projections: [withData('us:AOS')] });

    await scheduler.run();

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('🚨 存在 no-data 锚 → warn 列出 ticker (EC-15 不静默)', async () => {
    const { scheduler } = build({
      scanned: 2,
      updated: 1,
      projections: [withData('us:AOS'), noData('us:ACN')],
    });

    await scheduler.run();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('us:ACN');
    // 有数的那只不该出现在 no-data 名单里
    expect(String(warnSpy.mock.calls[0]?.[0])).not.toContain('us:AOS');
  });

  it('no-data 超过列举上限 → 截断并报剩余计数 (不刷屏)', async () => {
    const projections = Array.from({ length: 13 }, (_, i) => noData(`us:T${i}`));
    const { scheduler } = build({ scanned: 13, updated: 0, projections });

    await scheduler.run();

    const msg = String(warnSpy.mock.calls[0]?.[0]);
    expect(msg).toContain('+3 more');
    expect(msg).toContain('us:T0');
    expect(msg).not.toContain('us:T12');
  });

  it('🚨 名单不变 → 第二轮不重复 warn (每小时跑的承重前提: 同一条假警报重复 24 次 = 训练人无视它)', async () => {
    const { scheduler } = build({
      scanned: 2,
      updated: 0,
      projections: [withData('us:AOS'), noData('us:ACN')],
    });

    await scheduler.run();
    await scheduler.run();

    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('名单变化 → 重新 warn (去重按**内容**, 不是「只报一次」)', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ scanned: 1, updated: 0, projections: [noData('us:ACN')] })
      .mockResolvedValueOnce({
        scanned: 2,
        updated: 0,
        projections: [noData('us:ACN'), noData('us:KBR')],
      });
    const scheduler = new SyncAnchorQuoteScheduler({
      execute,
    } as unknown as SyncAnchorQuoteUseCase);

    await scheduler.run();
    await scheduler.run();

    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(String(warnSpy.mock.calls[1]?.[0])).toContain('us:KBR');
  });

  it('名单清空后又出现 → 重新 warn (指纹跟着回落, 不会永久静音)', async () => {
    const back = { scanned: 1, updated: 0, projections: [noData('us:ACN')] };
    const execute = vi
      .fn()
      .mockResolvedValueOnce(back)
      .mockResolvedValueOnce({ scanned: 1, updated: 1, projections: [withData('us:ACN')] })
      .mockResolvedValueOnce(back);
    const scheduler = new SyncAnchorQuoteScheduler({
      execute,
    } as unknown as SyncAnchorQuoteUseCase);

    await scheduler.run();
    await scheduler.run();
    await scheduler.run();

    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('🚨 use case 抛异常 → 只 ERROR log 返 null, **不上抛** (scheduler 抛 = 进程级 unhandledRejection)', async () => {
    const { scheduler } = build(new Error('db down'));

    await expect(scheduler.run()).resolves.toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('db down');
  });

  it('handleCron 委托给 run (cron 入口不另写逻辑)', async () => {
    const { scheduler, execute } = build({ scanned: 0, updated: 0, projections: [] });

    await expect(scheduler.handleCron()).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
