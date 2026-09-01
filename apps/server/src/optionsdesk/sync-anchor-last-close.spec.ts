import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import {
  REALTIME_QUOTE_MAX_SYMBOLS,
  RealtimeQuoteMarketUnsupportedError,
  type RealtimeQuote,
  type RealtimeQuotePort,
} from '../marketdata/realtime-quote.port';
import type { TradingCalendarPort } from '../marketdata/trading-calendar.port';
import type { PrismaService } from '../security/prisma.service';
import {
  SyncAnchorLastCloseUseCase,
  needsLastCloseRefresh,
  type MarketLastCloseOutcome,
} from './sync-anchor-last-close';

type Fn = ReturnType<typeof vi.fn>;

/**
 * ADR-0070 锚收盘价同源写手的纯单测。三闸各一条**能红**的用例 + 写入语义四条。
 *
 * 🚨 **`NOW` 的取值是判据的一部分**: 2026-09-01(周二) 16:30 HKT。此刻
 * · hk —— 已过 16:00 收盘 + 10 分钟 CAS 缓冲, 且未跨港股当地午夜 ⇒ **窗开**;
 * · us —— 同一绝对时刻 = 04:30 ET, 目标 session 是 08-31 而当地日历日已是 09-01 ⇒ **窗关**。
 * 一个 `NOW` 同时覆盖两侧, 顺带钉住「逐 market 独立判闸」这条 (混成全局一个闸时本文件会红)。
 */
const NOW = new Date('2026-09-01T08:30:00Z');
const TARGET_HK = '2026-09-01';
const CAPTURED_AT = new Date('2026-09-01T08:30:02.000Z');

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

interface AnchorSeed {
  id: bigint;
  ticker: string;
  lastCloseDate: Date | null;
}

interface Harness {
  useCase: SyncAnchorLastCloseUseCase;
  fetchQuotes: Fn;
  lastClosedSession: Fn;
  anchorUpdateMany: Fn;
}

function build(
  anchors: AnchorSeed[],
  sessions: Record<string, string | null> = { hk: TARGET_HK, us: '2026-08-31' },
): Harness {
  const anchorFindMany = vi.fn().mockResolvedValue(anchors);
  const anchorUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
  const prisma = {
    anchor: { findMany: anchorFindMany, updateMany: anchorUpdateMany },
  } as unknown as PrismaService;

  const fetchQuotes = vi.fn((symbols: readonly string[]) =>
    Promise.resolve(
      new Map<string, RealtimeQuote>(
        symbols.map((s) => [
          s,
          { price: '45.6700', capturedAt: CAPTURED_AT, vendorUpdateTime: null },
        ]),
      ),
    ),
  );
  const lastClosedSession = vi.fn((market: string) => Promise.resolve(sessions[market] ?? null));

  const useCase = new SyncAnchorLastCloseUseCase(
    prisma,
    { fetchQuotes } as unknown as RealtimeQuotePort,
    { lastClosedSession } as unknown as TradingCalendarPort,
  );
  return { useCase, fetchQuotes, lastClosedSession, anchorUpdateMany };
}

const outcomeOf = (markets: readonly MarketLastCloseOutcome[], market: string) =>
  markets.find((m) => m.market === market);

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('needsLastCloseRefresh — 工作集判据', () => {
  it('从未写过 (null) ⇒ 要采', () => {
    expect(needsLastCloseRefresh(null, TARGET_HK)).toBe(true);
  });

  it('已是目标那一场 ⇒ 不采 (幂等的来源)', () => {
    expect(needsLastCloseRefresh(day(TARGET_HK), TARGET_HK)).toBe(false);
  });

  it('🚨 比目标**更新**的日期 ⇒ 不采 —— 判据用 `<` 而非 `!==`, 只前进不后退', () => {
    // `!==` 会把人工改数 / 时钟回拨造出来的更新值拉回来覆盖成更旧的那一场。
    expect(needsLastCloseRefresh(day('2026-09-02'), TARGET_HK)).toBe(false);
  });
});

describe('SyncAnchorLastCloseUseCase — 三闸', () => {
  it('🚨 闸①: 日历不可判定 ⇒ skipped-undecidable, **0 次外呼** (不猜日子)', async () => {
    const h = build([{ id: 1n, ticker: 'hk:00700', lastCloseDate: null }], { hk: null });

    const report = await h.useCase.execute(NOW);

    expect(outcomeOf(report.markets, 'hk')).toEqual({
      market: 'hk',
      status: 'skipped-undecidable',
    });
    expect(h.fetchQuotes).not.toHaveBeenCalled();
    expect(h.anchorUpdateMany).not.toHaveBeenCalled();
  });

  it('🚨 闸②: 窗未开 ⇒ skipped-window, **0 次外呼** —— us 在本 NOW 下正是这一档', async () => {
    const h = build([{ id: 1n, ticker: 'us:AOS', lastCloseDate: day('2026-08-28') }]);

    const report = await h.useCase.execute(NOW);

    expect(outcomeOf(report.markets, 'us')).toEqual({
      market: 'us',
      status: 'skipped-window',
      target: '2026-08-31',
    });
    expect(h.fetchQuotes).not.toHaveBeenCalled();
  });

  it('🚨 闸③: 工作集空 ⇒ up-to-date, **0 次外呼** —— 稳态就落在这个出口', async () => {
    const h = build([{ id: 1n, ticker: 'hk:00700', lastCloseDate: day(TARGET_HK) }]);

    const report = await h.useCase.execute(NOW);

    expect(outcomeOf(report.markets, 'hk')).toEqual({
      market: 'hk',
      status: 'up-to-date',
      target: TARGET_HK,
      anchors: 1,
    });
    expect(h.fetchQuotes).not.toHaveBeenCalled();
    expect(h.anchorUpdateMany).not.toHaveBeenCalled();
  });

  it('🚨 逐 market 独立判闸: 同一拍里 hk 采、us 因窗关不采', async () => {
    const h = build([
      { id: 1n, ticker: 'hk:00700', lastCloseDate: day('2026-08-31') },
      { id: 2n, ticker: 'us:AOS', lastCloseDate: day('2026-08-28') },
    ]);

    const report = await h.useCase.execute(NOW);

    expect(outcomeOf(report.markets, 'hk')?.status).toBe('collected');
    expect(outcomeOf(report.markets, 'us')?.status).toBe('skipped-window');
    // 只对 hk 那一组发过请求
    expect(h.fetchQuotes).toHaveBeenCalledTimes(1);
    expect(h.fetchQuotes).toHaveBeenCalledWith(['hk:00700']);
  });
});

describe('SyncAnchorLastCloseUseCase — 写入语义', () => {
  it('🚨 lastCloseDate 写的是**目标 session**, 不是 vendor 的 capturedAt (ADR-0066 两条轴)', async () => {
    const h = build([{ id: 1n, ticker: 'hk:00700', lastCloseDate: day('2026-08-31') }]);

    await h.useCase.execute(NOW);

    const arg = h.anchorUpdateMany.mock.calls[0][0];
    expect(arg.where).toEqual({ id: 1n });
    expect(arg.data.lastClose.toString()).toBe('45.67');
    // capturedAt 是 08:30:02Z (ingestion time); 落库的必须是 event time 的 UTC 午夜。
    expect(arg.data.lastCloseDate.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(arg.data.lastCloseDate.toISOString()).not.toBe(CAPTURED_AT.toISOString());
  });

  it('🚨 响应里没有该 ticker ⇒ 保留旧值 (既不写 null 也不写 0)', async () => {
    const h = build([
      { id: 1n, ticker: 'hk:00700', lastCloseDate: day('2026-08-31') },
      { id: 2n, ticker: 'hk:06117', lastCloseDate: day('2026-08-28') },
    ]);
    // 停牌: adapter 侧 0 哨兵已归一为 null ⇒ 到这里就是「行不在 Map 里」。
    h.fetchQuotes.mockResolvedValueOnce(
      new Map<string, RealtimeQuote>([
        ['hk:00700', { price: '45.6700', capturedAt: CAPTURED_AT, vendorUpdateTime: null }],
      ]),
    );

    const report = await h.useCase.execute(NOW);

    expect(h.anchorUpdateMany).toHaveBeenCalledTimes(1);
    expect(h.anchorUpdateMany.mock.calls[0][0].where).toEqual({ id: 1n });
    const hk = outcomeOf(report.markets, 'hk');
    expect(hk).toMatchObject({ status: 'collected', work: 2, quoted: 1, updated: 1 });
  });

  it('🚨 未登记实时源 ⇒ unsupported-market, **不计源故障** (配置事实 ≠ 故障)', async () => {
    const h = build([{ id: 1n, ticker: 'hk:00700', lastCloseDate: null }]);
    h.fetchQuotes.mockRejectedValueOnce(new RealtimeQuoteMarketUnsupportedError('hk', ['us']));

    const report = await h.useCase.execute(NOW);

    expect(outcomeOf(report.markets, 'hk')).toEqual({
      market: 'hk',
      status: 'unsupported-market',
      registeredMarkets: ['us'],
    });
    expect(report.sourceFailures).toBe(0);
    expect(report.unsupportedMarkets).toEqual(['hk']);
    expect(h.anchorUpdateMany).not.toHaveBeenCalled();
  });

  it('源故障 ⇒ 计 sourceFailures, 保留旧值, 不上抛 (下一拍工作集还在 ⇒ 自动重试)', async () => {
    const h = build([{ id: 1n, ticker: 'hk:00700', lastCloseDate: null }]);
    h.fetchQuotes.mockRejectedValueOnce(new Error('隧道断了'));

    const report = await h.useCase.execute(NOW);

    expect(report.sourceFailures).toBe(1);
    expect(report.updated).toBe(0);
    expect(h.anchorUpdateMany).not.toHaveBeenCalled();
  });

  it('切批按 REALTIME_QUOTE_MAX_SYMBOLS, 逐批独立成败', async () => {
    const anchors: AnchorSeed[] = Array.from(
      { length: REALTIME_QUOTE_MAX_SYMBOLS + 3 },
      (_, i) => ({
        id: BigInt(i + 1),
        ticker: `hk:${String(i).padStart(5, '0')}`,
        lastCloseDate: null,
      }),
    );
    const h = build(anchors);

    const report = await h.useCase.execute(NOW);

    expect(h.fetchQuotes).toHaveBeenCalledTimes(2);
    expect(h.fetchQuotes.mock.calls[0][0]).toHaveLength(REALTIME_QUOTE_MAX_SYMBOLS);
    expect(h.fetchQuotes.mock.calls[1][0]).toHaveLength(3);
    expect(outcomeOf(report.markets, 'hk')).toMatchObject({ batches: 2, failedBatches: 0 });
  });

  it('不成形的 ticker 归空串组 ⇒ 闸① 挡下 (不猜市场, 与 061 同向)', async () => {
    const h = build([{ id: 1n, ticker: 'NOPE', lastCloseDate: null }]);

    const report = await h.useCase.execute(NOW);

    expect(outcomeOf(report.markets, '')).toEqual({ market: '', status: 'skipped-undecidable' });
    expect(h.fetchQuotes).not.toHaveBeenCalled();
  });
});
