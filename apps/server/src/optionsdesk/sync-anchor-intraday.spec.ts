import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import {
  REALTIME_QUOTE_MAX_SYMBOLS,
  RealtimeQuoteMarketUnsupportedError,
  type RealtimeQuote,
  type RealtimeQuotePort,
} from '../marketdata/realtime-quote.port';
import type { MarketSession, MarketStatePort } from '../marketdata/market-state.port';
import type { TradingCalendarPort } from '../marketdata/trading-calendar.port';
import type { TradingDayStatus } from '../marketdata/trading-day.rules';
import type { PrismaService } from '../security/prisma.service';
import {
  SyncAnchorIntradayUseCase,
  classifyTickSource,
  marketsNeedingClosingTick,
  type SyncAnchorIntradayReport,
} from './sync-anchor-intraday';

type Fn = ReturnType<typeof vi.fn>;

/** 采集墙钟 —— 来自 shim 信封的 `as_of`, **不是**本机时钟 (port 契约)。 */
const CAPTURED_AT = new Date('2026-08-17T14:31:05.000Z');
/** vendor 自报的「最新价时刻」—— 蓄意早于 {@link CAPTURED_AT}, 两者混用会被断言逮住。 */
const VENDOR_AT = new Date('2026-08-17T14:30:25.000Z');
const NOW = new Date('2026-08-17T14:31:06.000Z');

const anchorRow = (id: bigint, ticker: string) => ({ id, ticker });

interface PrismaMock {
  prisma: PrismaService;
  anchorFindMany: Fn;
  anchorUpdateMany: Fn;
  anchorChangeCreate: Fn;
}

/**
 * ⚠️ **062 T008 起本 mock 不再有 `tradingDay`** —— 交易日闸改走 `TRADING_CALENDAR_PORT`
 * (optionsdesk 的唯一 module 边)。留着那个假方法只会让「实现又退回裸直查」这件事静默通过。
 */
function buildPrismaMock(anchors: { id: bigint; ticker: string }[]): PrismaMock {
  const anchorFindMany = vi.fn().mockResolvedValue(anchors);
  const anchorUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
  const anchorChangeCreate = vi.fn().mockResolvedValue({});
  const prisma = {
    anchor: { findMany: anchorFindMany, updateMany: anchorUpdateMany },
    anchorChange: { create: anchorChangeCreate, createMany: anchorChangeCreate },
  } as unknown as PrismaService;
  return { prisma, anchorFindMany, anchorUpdateMany, anchorChangeCreate };
}

function quoteMapOf(symbols: readonly string[], price = '123.4500'): Map<string, RealtimeQuote> {
  return new Map(
    symbols.map((s) => [s, { price, capturedAt: CAPTURED_AT, vendorUpdateTime: VENDOR_AT }]),
  );
}

interface Harness {
  useCase: SyncAnchorIntradayUseCase;
  m: PrismaMock;
  fetchQuotes: Fn;
  getMarketSessions: Fn;
  /** 交易日历读端口替身 —— 默认 `trading`, 用例按需摆成 `non-trading` / `unknown`。 */
  classify: Fn;
}

function build(
  anchors: { id: bigint; ticker: string }[],
  sessions: { market: string; session: MarketSession }[] = [{ market: 'us', session: 'regular' }],
): Harness {
  const m = buildPrismaMock(anchors);
  const fetchQuotes = vi.fn((symbols: readonly string[]) => Promise.resolve(quoteMapOf(symbols)));
  const getMarketSessions = vi.fn().mockResolvedValue(sessions);
  const classify = vi.fn().mockResolvedValue('trading' satisfies TradingDayStatus);
  const useCase = new SyncAnchorIntradayUseCase(
    m.prisma,
    { fetchQuotes } as unknown as RealtimeQuotePort,
    { getMarketSessions } as unknown as MarketStatePort,
    {
      classify,
      lastClosedSession: async () => null,
      previousTradingDay: async () => null,
    } as unknown as TradingCalendarPort,
  );
  return { useCase, m, fetchQuotes, getMarketSessions, classify };
}

/** 该 market 组的处置 (断言用; 找不到即 undefined, 让断言自己红)。 */
const outcomeOf = (report: SyncAnchorIntradayReport, market: string) =>
  report.markets.find((o) => o.market === market);

describe('marketsNeedingClosingTick — 收盘补一拍判据 (FR-005)', () => {
  it('上一拍常规 ∧ 本拍不在白名单 → 该 market 需要补一拍', () => {
    expect(marketsNeedingClosingTick({ us: 'regular' }, { us: 'other' })).toEqual(['us']);
  });

  it('两拍都常规 → 不补 (补一拍只在**离开**白名单那一次发生)', () => {
    expect(marketsNeedingClosingTick({ us: 'regular' }, { us: 'regular' })).toEqual([]);
  });

  it('上一拍已不在白名单 → 不补 (否则收盘后每拍都补 = 全天采集)', () => {
    expect(marketsNeedingClosingTick({ us: 'other' }, { us: 'other' })).toEqual([]);
  });

  it('无上一拍状态 (进程刚起 / 状态曾不可得) → 不补, MUST NOT 猜', () => {
    expect(marketsNeedingClosingTick(null, { us: 'other' })).toEqual([]);
  });
});

describe('classifyTickSource — 「配置事实」与「源故障」的分界 (Guardrail 16)', () => {
  const base: SyncAnchorIntradayReport = {
    sessions: { us: 'regular' },
    markets: [],
    sourceFailures: 0,
    sourceSuccesses: 0,
    unsupportedMarkets: [],
    scanned: 0,
    updated: 0,
  };

  it('有成功批次 → success (哪怕同拍还有失败批次: 判据是「全部失败」)', () => {
    expect(classifyTickSource({ ...base, sourceSuccesses: 1, sourceFailures: 1 })).toBe('success');
  });

  it('全是失败批次 → failure', () => {
    expect(classifyTickSource({ ...base, sourceFailures: 2 })).toBe('failure');
  });

  it('🚨 一次源调用都没发生 (全被闸挡下 / 全是无路由市场) → no-attempt, **不是** failure', () => {
    expect(classifyTickSource({ ...base, unsupportedMarkets: ['cn'] })).toBe('no-attempt');
  });
});

describe('SyncAnchorIntradayUseCase — 盘中价投影 tick (FR-004/005/011/017)', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('常规时段 + 交易日 → 采集并只写自有两列 (state_branch 1)', async () => {
    const { useCase, m, fetchQuotes } = build([anchorRow(7n, 'us:AOS')]);

    const report = await useCase.execute(NOW);

    expect(fetchQuotes).toHaveBeenCalledTimes(1);
    expect(fetchQuotes.mock.calls[0]?.[0]).toEqual(['us:AOS']);
    expect(m.anchorUpdateMany).toHaveBeenCalledTimes(1);
    expect(m.anchorUpdateMany.mock.calls[0]?.[0]).toEqual({
      where: { id: 7n },
      data: {
        intradayPrice: new Prisma.Decimal('123.4500'),
        intradayAt: CAPTURED_AT,
        intradayVendorUpdateTime: VENDOR_AT,
      },
    });
    expect(report.updated).toBe(1);
    expect(report.sourceSuccesses).toBe(1);
    expect(classifyTickSource(report)).toBe('success');
  });

  it('🚨 两列不入痕迹表 (同 last_close 的既有规矩, Guardrail 15)', async () => {
    const { useCase, m } = build([anchorRow(7n, 'us:AOS')]);

    await useCase.execute(NOW);

    expect(m.anchorChangeCreate).not.toHaveBeenCalled();
  });

  it('白名单外的已知状态 → 0 次源调用, 且不清空既有实时价 (state_branch 2)', async () => {
    const { useCase, m, fetchQuotes } = build(
      [anchorRow(7n, 'us:AOS')],
      [{ market: 'us', session: 'other' }],
    );

    const report = await useCase.execute(NOW);

    expect(fetchQuotes).not.toHaveBeenCalled();
    expect(m.anchorUpdateMany).not.toHaveBeenCalled();
    expect(outcomeOf(report, 'us')).toMatchObject({ status: 'skipped-session', session: 'other' });
    expect(classifyTickSource(report)).toBe('no-attempt');
  });

  it('未知状态 → 同样 0 次源调用 (MUST NOT 猜成开市, state_branch 3)', async () => {
    const { useCase, fetchQuotes } = build(
      [anchorRow(7n, 'us:AOS')],
      [{ market: 'us', session: 'unknown' }],
    );

    const report = await useCase.execute(NOW);

    expect(fetchQuotes).not.toHaveBeenCalled();
    expect(outcomeOf(report, 'us')).toMatchObject({
      status: 'skipped-session',
      session: 'unknown',
    });
  });

  it('🚨 状态说开市但当天非交易日 → 0 次源调用 (两闸取交集, 交易日闸不可被顶替, state_branch 5)', async () => {
    const { useCase, classify, fetchQuotes } = build([anchorRow(7n, 'us:AOS')]);
    classify.mockResolvedValue('non-trading' satisfies TradingDayStatus);

    const report = await useCase.execute(NOW);

    expect(classify).toHaveBeenCalledTimes(1);
    expect(fetchQuotes).not.toHaveBeenCalled();
    expect(outcomeOf(report, 'us')).toMatchObject({ status: 'skipped-holiday' });
    expect(classifyTickSource(report)).toBe('no-attempt');
  });

  /**
   * 🚨 **062 T008 —— `unknown` 落在放行侧**。它说的是「日历还没填到今天」而不是「今天不是
   * 交易日」; 判成后者 = 每天开盘前整段静默停摆 (062 要消灭的病根)。留痕必须与 `confirmed`
   * 分得出 (FR-013), 否则事后查不出「这一拍为什么采了」。
   */
  it('🚨 交易日判定为 unknown → 照常采集且留痕标 unknown (FR-012/FR-013, state_branch 5)', async () => {
    const { useCase, classify, fetchQuotes } = build([anchorRow(7n, 'us:AOS')]);
    classify.mockResolvedValue('unknown' satisfies TradingDayStatus);

    const report = await useCase.execute(NOW);

    expect(fetchQuotes).toHaveBeenCalledTimes(1);
    expect(outcomeOf(report, 'us')).toMatchObject({ status: 'collected', calendar: 'unknown' });
  });

  it('状态不可得 → 0 次源调用, 计为**源故障** (fail-closed, state_branch 4)', async () => {
    const { useCase, m, fetchQuotes, getMarketSessions } = build([anchorRow(7n, 'us:AOS')]);
    getMarketSessions.mockRejectedValue(new Error('shim unreachable'));

    const report = await useCase.execute(NOW);

    expect(fetchQuotes).not.toHaveBeenCalled();
    expect(m.anchorUpdateMany).not.toHaveBeenCalled();
    expect(report.sessions).toBeNull();
    expect(report.sourceFailures).toBe(1);
    expect(classifyTickSource(report)).toBe('failure');
  });

  it('🚨 无实时源路由的市场 → 独立成组、显式降级、回报为**配置事实**而非源故障; us 组照常成功 (Guardrail 16 / state_branch 14)', async () => {
    // ⚠️ 例子用 cn 而非 hk: hk 自 066 T10 起已接上实时源 (live 档 us + hk), 拿它当「无路由」
    // 的例子会让这条回归钉说一件已经不成立的事。cn 的现役实时源仍挂在 `alert/` 里。
    const { useCase, m, fetchQuotes } = build(
      [anchorRow(7n, 'us:AOS'), anchorRow(9n, 'cn:600519')],
      [
        { market: 'us', session: 'regular' },
        { market: 'cn', session: 'regular' },
      ],
    );
    fetchQuotes.mockImplementation((symbols: readonly string[]) =>
      symbols[0]?.startsWith('cn:')
        ? Promise.reject(new RealtimeQuoteMarketUnsupportedError('cn', ['us', 'hk']))
        : Promise.resolve(quoteMapOf(symbols)),
    );

    const report = await useCase.execute(NOW);

    // 分组: 两个 market 各发一次, 互不牵连。
    expect(fetchQuotes).toHaveBeenCalledTimes(2);
    expect(report.unsupportedMarkets).toEqual(['cn']);
    // 🚨 这条是回归钉: 无路由 MUST NOT 进源故障计数, 否则一只无路由锚 90 秒后把 us 一起降级。
    expect(report.sourceFailures).toBe(0);
    expect(report.sourceSuccesses).toBe(1);
    expect(classifyTickSource(report)).toBe('success');
    expect(outcomeOf(report, 'cn')).toMatchObject({ status: 'unsupported-market' });
    // us 那只照常落库。
    expect(m.anchorUpdateMany).toHaveBeenCalledTimes(1);
    expect(m.anchorUpdateMany.mock.calls[0]?.[0]).toMatchObject({ where: { id: 7n } });
  });

  it('🚨 401 只锚 → 恰好切成 2 批 (切批是调用方的事, Guardrail 17)', async () => {
    const anchors = Array.from({ length: REALTIME_QUOTE_MAX_SYMBOLS + 1 }, (_, i) =>
      anchorRow(BigInt(i + 1), `us:T${i}`),
    );
    const { useCase, fetchQuotes } = build(anchors);

    await useCase.execute(NOW);

    expect(fetchQuotes).toHaveBeenCalledTimes(2);
    expect(fetchQuotes.mock.calls[0]?.[0]).toHaveLength(REALTIME_QUOTE_MAX_SYMBOLS);
    expect(fetchQuotes.mock.calls[1]?.[0]).toHaveLength(1);
  });

  it('🚨 一批失败 → 另一批仍落库, MUST NOT 整批回滚 (state_branch 8)', async () => {
    const anchors = Array.from({ length: REALTIME_QUOTE_MAX_SYMBOLS + 1 }, (_, i) =>
      anchorRow(BigInt(i + 1), `us:T${i}`),
    );
    const { useCase, m, fetchQuotes } = build(anchors);
    fetchQuotes
      .mockImplementationOnce(() => Promise.reject(new Error('shim 504')))
      .mockImplementationOnce((symbols: readonly string[]) => Promise.resolve(quoteMapOf(symbols)));

    const report = await useCase.execute(NOW);

    expect(report.sourceFailures).toBe(1);
    expect(report.sourceSuccesses).toBe(1);
    // 失败批的 400 只保留旧值, 成功批的 1 只落库。
    expect(m.anchorUpdateMany).toHaveBeenCalledTimes(1);
    expect(report.updated).toBe(1);
    // 同拍有成功批次 ⇒ 不是「全断」, 不该计熔断。
    expect(classifyTickSource(report)).toBe('success');
  });

  it('响应缺某标的 → 该锚两列不变 (既不写 null 也不写 0, state_branch 7)', async () => {
    const { useCase, m, fetchQuotes } = build([anchorRow(7n, 'us:AOS'), anchorRow(9n, 'us:CPB')]);
    fetchQuotes.mockImplementation(() => Promise.resolve(quoteMapOf(['us:AOS'])));

    const report = await useCase.execute(NOW);

    expect(m.anchorUpdateMany).toHaveBeenCalledTimes(1);
    expect(m.anchorUpdateMany.mock.calls[0]?.[0]).toMatchObject({ where: { id: 7n } });
    expect(report.updated).toBe(1);
    expect(report.scanned).toBe(2);
  });

  it('🚨 外呼在 tx 外、一次取整批 (split-tx): 全程零 $transaction', async () => {
    const m = buildPrismaMock([anchorRow(7n, 'us:AOS')]);
    const transaction = vi.fn();
    (m.prisma as unknown as { $transaction: Fn }).$transaction = transaction;
    const useCase = new SyncAnchorIntradayUseCase(
      m.prisma,
      { fetchQuotes: vi.fn((s: readonly string[]) => Promise.resolve(quoteMapOf(s))) },
      { getMarketSessions: vi.fn().mockResolvedValue([{ market: 'us', session: 'regular' }]) },
      {
        classify: vi.fn().mockResolvedValue('trading' satisfies TradingDayStatus),
        lastClosedSession: async () => null,
        previousTradingDay: async () => null,
      },
    );

    await useCase.execute(NOW);

    expect(transaction).not.toHaveBeenCalled();
  });

  it('收盘补一拍: 上一拍常规 ∧ 本拍不在 → 强制采一次 (FR-005 / state_branch 6)', async () => {
    const { useCase, fetchQuotes } = build(
      [anchorRow(7n, 'us:AOS')],
      [{ market: 'us', session: 'other' }],
    );

    const report = await useCase.execute(NOW, { previousSessions: { us: 'regular' } });

    expect(fetchQuotes).toHaveBeenCalledTimes(1);
    expect(outcomeOf(report, 'us')).toMatchObject({ status: 'collected', forced: true });
  });

  it('收盘补一拍的下一拍不再补 (上一拍已不在白名单)', async () => {
    const { useCase, fetchQuotes } = build(
      [anchorRow(7n, 'us:AOS')],
      [{ market: 'us', session: 'other' }],
    );

    await useCase.execute(NOW, { previousSessions: { us: 'other' } });

    expect(fetchQuotes).not.toHaveBeenCalled();
  });

  it('补一拍仍受交易日闸约束 (两闸交集不因强制而放开)', async () => {
    const { useCase, classify, fetchQuotes } = build(
      [anchorRow(7n, 'us:AOS')],
      [{ market: 'us', session: 'other' }],
    );
    classify.mockResolvedValue('non-trading' satisfies TradingDayStatus);

    await useCase.execute(NOW, { previousSessions: { us: 'regular' } });

    expect(fetchQuotes).not.toHaveBeenCalled();
  });

  it('ticker 不成形 → 归入无路由的空市场组、零外呼 (不猜市场)', async () => {
    const { useCase, fetchQuotes } = build([anchorRow(7n, 'AOS')]);

    const report = await useCase.execute(NOW);

    expect(fetchQuotes).not.toHaveBeenCalled();
    expect(report.updated).toBe(0);
  });

  it('零锚 → 零外呼, 但仍回报本拍时段 (T008 的补一拍判据靠它)', async () => {
    const { useCase, fetchQuotes } = build([]);

    const report = await useCase.execute(NOW);

    expect(fetchQuotes).not.toHaveBeenCalled();
    expect(report.sessions).toEqual({ us: 'regular' });
  });
});

// ---------------------------------------------------------------------------
// 066 T10 — 港股接上实时源之后的四条分支 (FR-003, plan §A7)
// ---------------------------------------------------------------------------
/**
 * 🚨 **午休 / 提前收盘由「供应方的市场时段状态」挡, 不由本地时段表挡** (tasks.md 排序铁律 6)。
 * 本文件看到的是归一后的三态, 归一那一层的断言在 `marketdata/futu-market-state.adapter.spec.ts`
 * 的「066 T10 港股时段」段 (午休 `REST` → `other`)。两层分开断: 这里验「非 regular ⇒ 不采」,
 * 那里验「vendor 的哪些串算 regular」。
 *
 * ⑤ **既有 cn 盘中告警通路逐点不动**: 它挂在 `alert/`, 有**自己的** `REALTIME_QUOTE_PORT`
 * symbol 与 `INTRADAY_MARKET = 'cn'` (钉在 `alert/intraday-eval.processor.it.spec.ts`),
 * 与本 ctx 的端口不是同一个 token ⇒ 本 task 对它零触碰。
 */
describe('066 T10 SyncAnchorIntradayUseCase — 港股盘中价投影', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('① 港股连续竞价时段 → 实时价投影到锚 (state_branches 16)', async () => {
    const { useCase, m, fetchQuotes } = build(
      [anchorRow(9n, 'hk:00700')],
      [{ market: 'hk', session: 'regular' }],
    );

    const report = await useCase.execute(NOW);

    expect(fetchQuotes.mock.calls[0]?.[0]).toEqual(['hk:00700']);
    // 🚨 补上槽位之前这里是 `unsupported-market` (0 次源调用、恒为收盘档且不报警)。
    expect(report.unsupportedMarkets).toEqual([]);
    expect(outcomeOf(report, 'hk')).toMatchObject({
      status: 'collected',
      anchors: 1,
      quoted: 1,
      updated: 1,
    });
    expect(m.anchorUpdateMany.mock.calls[0]?.[0]).toEqual({
      where: { id: 9n },
      data: {
        intradayPrice: new Prisma.Decimal('123.4500'),
        intradayAt: CAPTURED_AT,
        intradayVendorUpdateTime: VENDOR_AT,
      },
    });
    expect(classifyTickSource(report)).toBe('success');
  });

  it('② 港股午休 (vendor REST → other) → 0 次源调用, 且 MUST NOT 把午休盘口写成盘中价 (state_branches 17)', async () => {
    const { useCase, m, fetchQuotes } = build(
      [anchorRow(9n, 'hk:00700')],
      [{ market: 'hk', session: 'other' }],
    );

    const report = await useCase.execute(NOW);

    expect(fetchQuotes).not.toHaveBeenCalled();
    // 既不写新值也不清旧值 —— 该锚这一拍维持上一次的两列。
    expect(m.anchorUpdateMany).not.toHaveBeenCalled();
    expect(outcomeOf(report, 'hk')).toEqual({
      market: 'hk',
      status: 'skipped-session',
      session: 'other',
    });
    // 时段闸挡下 ≠ 源故障: 一次调用都没发生 ⇒ 既不计失败也不清熔断计数。
    expect(classifyTickSource(report)).toBe('no-attempt');
  });

  it('③ 港股非交易日 → 0 次源调用, 保留收盘档 (state_branches 18)', async () => {
    const { useCase, m, fetchQuotes, classify } = build(
      [anchorRow(9n, 'hk:00700')],
      [{ market: 'hk', session: 'regular' }],
    );
    classify.mockResolvedValue('non-trading' satisfies TradingDayStatus);

    const report = await useCase.execute(NOW);

    expect(fetchQuotes).not.toHaveBeenCalled();
    expect(m.anchorUpdateMany).not.toHaveBeenCalled();
    expect(outcomeOf(report, 'hk')).toMatchObject({ status: 'skipped-holiday' });
  });

  it('③ 港股收盘后 (vendor CLOSED → other) → 同样不写盘中价 (state_branches 18)', async () => {
    const { useCase, m, fetchQuotes } = build(
      [anchorRow(9n, 'hk:00700')],
      [{ market: 'hk', session: 'other' }],
    );

    const report = await useCase.execute(NOW);

    expect(fetchQuotes).not.toHaveBeenCalled();
    expect(m.anchorUpdateMany).not.toHaveBeenCalled();
    expect(report.updated).toBe(0);
  });

  it('④ 港股半日市当天下午 → 当天**仍是交易日**, 挡它的是时段闸 (state_branches 19)', async () => {
    // ⚠️ **未实测**: 半日市 12:00 提前收盘之后供应方报 REST 还是 CLOSED, 本机够不到 vendor,
    // 待 T15 在真锚上收口。⇒ 本条**不**断「半日市 = 某个具体状态串」(那要靠推断, 会写出一条
    // 假绿), 只断这条链上真正成立的那一层: **交易日闸放行、时段闸独立生效**, 只要供应方报的
    // 不是白名单状态就一拍不采 —— 归一层「REST / CLOSED / HK_CAS 全归 other」的断言在
    // `futu-market-state.adapter.spec.ts`。
    const { useCase, m, fetchQuotes, classify } = build(
      [anchorRow(9n, 'hk:00700')],
      [{ market: 'hk', session: 'other' }],
    );

    const report = await useCase.execute(NOW);

    // 日历闸没被触发: 时段闸在它之前就短路了 (0 次 classify)。半日市当天是交易日, 拿日历
    // 去挡它反而会挡掉上午那半场。
    expect(classify).not.toHaveBeenCalled();
    expect(fetchQuotes).not.toHaveBeenCalled();
    expect(m.anchorUpdateMany).not.toHaveBeenCalled();
    expect(outcomeOf(report, 'hk')).toMatchObject({ status: 'skipped-session' });
  });
});
