import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EnsureLatestEodBarUseCase } from './ensure-latest-eod-bar.usecase';
import type { PrismaService } from '../security/prisma.service';
import type { EodBarPort } from './eod-bar.port';
import type { EodBarPoint } from './marketdata.types';

type Fn = ReturnType<typeof vi.fn>;

function bar(tradeDate: string, close: string): EodBarPoint {
  return {
    tradeDate,
    adjust: 'none',
    open: close,
    high: close,
    low: close,
    close,
    changePct: null,
    prevClose: null,
    volume: null,
    amount: null,
    turnoverRate: null,
  };
}

function build(): {
  useCase: EnsureLatestEodBarUseCase;
  instrumentFindUnique: Fn;
  createMany: Fn;
  upsert: Fn;
  getBars: Fn;
} {
  const instrumentFindUnique = vi.fn().mockResolvedValue({ id: 42n });
  const createMany = vi.fn().mockResolvedValue({ count: 0 });
  const upsert = vi.fn().mockResolvedValue({});
  const getBars = vi.fn().mockResolvedValue([]);
  // 写路径与采集轮共用 `writeDailyBarRows` ⇒ double 必须同时给出 `$transaction` 与尾窗
  // 用的 `upsert`;「落了几行」的断言看 upsert (小批全落在尾窗内, createMany 不会被调)。
  const prisma = {
    instrument: { findUnique: instrumentFindUnique },
    dailyBar: { createMany, upsert },
    $transaction: (fn: (tx: unknown) => Promise<unknown>) => fn({ dailyBar: { upsert } }),
  } as unknown as PrismaService;
  const eodBar = { getBars } as unknown as EodBarPort;
  return {
    useCase: new EnsureLatestEodBarUseCase(prisma, eodBar),
    instrumentFindUnique,
    createMany,
    upsert,
    getBars,
  };
}

describe('EnsureLatestEodBarUseCase — 单标的按需取最近收盘 + 幂等落库', () => {
  let ctx: ReturnType<typeof build>;

  beforeEach(() => {
    ctx = build();
  });

  it('ticker 不可解析 ⇒ 返 null 且**零 vendor 调用** (别为一个畸形串去打外部)', async () => {
    const result = await ctx.useCase.execute('garbage', '2026-08-17');

    expect(result).toBeNull();
    expect(ctx.getBars).not.toHaveBeenCalled();
    expect(ctx.instrumentFindUnique).not.toHaveBeenCalled();
  });

  it('标的未在 instrument 注册 ⇒ 返 null、零 vendor 调用, 且**不代建 instrument 行**', async () => {
    ctx.instrumentFindUnique.mockResolvedValue(null);

    const result = await ctx.useCase.execute('us:PDD', '2026-08-17');

    expect(result).toBeNull();
    expect(ctx.getBars).not.toHaveBeenCalled();
    expect(ctx.createMany).not.toHaveBeenCalled();
    expect(ctx.upsert).not.toHaveBeenCalled();
  });

  it('vendor 返空 (停牌 / 新股) ⇒ 返 null、零落库, 非错误', async () => {
    ctx.getBars.mockResolvedValue([]);

    const result = await ctx.useCase.execute('us:PDD', '2026-08-17');

    expect(result).toBeNull();
    expect(ctx.createMany).not.toHaveBeenCalled();
    expect(ctx.upsert).not.toHaveBeenCalled();
  });

  it('取到数据 ⇒ 以 none 口径落库 (≤ 尾窗 ⇒ 全走 upsert), 回看窗按 targetDate 倒推', async () => {
    ctx.getBars.mockResolvedValue([bar('2026-08-14', '84.79'), bar('2026-08-17', '86.94')]);

    const result = await ctx.useCase.execute('us:PDD', '2026-08-17');

    expect(ctx.getBars).toHaveBeenCalledWith({
      symbol: 'us:PDD',
      adjust: 'none',
      from: '2026-08-07', // targetDate − 10 天
      to: '2026-08-17',
    });
    // 两根都落在尾窗内 ⇒ 逐根 upsert, 头部 createMany 无事可做。
    expect(ctx.createMany).not.toHaveBeenCalled();
    const written = ctx.upsert.mock.calls.map(
      (c) =>
        (c as [{ create: { instrumentId: bigint; adjust: string; tradeDate: Date } }])[0].create,
    );
    expect(written).toHaveLength(2);
    expect(written.every((r) => r.instrumentId === 42n && r.adjust === 'none')).toBe(true);
    expect(result?.close).toBe('86.94');
  });

  it('🚨 端口若不按升序返回, 仍取 tradeDate 最大的那根 (取错只会静默差几天, 不报错)', async () => {
    ctx.getBars.mockResolvedValue([
      bar('2026-08-17', '86.94'),
      bar('2026-08-11', '90.50'),
      bar('2026-08-13', '84.17'),
    ]);

    const result = await ctx.useCase.execute('us:PDD', '2026-08-17');

    expect(result?.tradeDate).toBe('2026-08-17');
    expect(result?.close).toBe('86.94');
  });
});
