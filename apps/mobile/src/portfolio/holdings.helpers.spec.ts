import { describe, expect, it } from 'vitest';
import type { HoldingItem, QuoteItem, TradeItem } from '@nvy/api-client';

import {
  floatPnl,
  floatPnlPct,
  formatAmount,
  formatQty,
  formatRatioPct,
  formatSignedAmount,
  groupTradesByMonth,
  marketValue,
  pnlDirection,
  summarizeHoldings,
} from './holdings.helpers';

// stub 数据纯合成（虚构标的与数值）：合成甲股份 ZQX（1400 股 / 成本 13.45 / 现价 14 /
// 累计盈亏 +2345.6）、合成乙科技 ZQY（7000 股 / 成本 7.25 / 现价 7）、
// 合成逆回购 ZQR 降级行（quotable=false）。

const holding = (over: Partial<HoldingItem>): HoldingItem => ({
  id: '1',
  market: 'cn',
  code: 'ZQX',
  name: '合成甲股份',
  qty: '1400',
  unitCost: '13.45',
  weightPct: '0.3',
  holdDays: 8,
  cumPnl: '2345.6',
  cumPnlPct: '0.1319',
  quotable: true,
  ...over,
});

const quote = (over: Partial<QuoteItem>): QuoteItem =>
  ({
    symbol: 'cn:ZQX',
    hasData: true,
    price: '14',
    change: '0.25',
    changePct: '1.82',
    ...over,
  }) as QuoteItem;

const trade = (over: Partial<TradeItem>): TradeItem => ({
  id: '1',
  market: 'cn',
  code: 'ZQX',
  name: '合成甲股份',
  category: 'buy',
  tradeDate: '2026-02-02',
  tradeTime: '10:41:17',
  qty: '1400',
  price: '13.45',
  amount: '-18835.65',
  turnover: '18830',
  fee: '5.65',
  note: null,
  ...over,
});

describe('marketValue', () => {
  it('computes price × qty', () => {
    expect(marketValue(quote({}), holding({}))).toBeCloseTo(19600, 6);
  });

  it('returns null for degraded rows (quotable=false)', () => {
    expect(marketValue(quote({}), holding({ quotable: false }))).toBeNull();
  });

  it('returns null without quote / hasData=false / null price', () => {
    expect(marketValue(undefined, holding({}))).toBeNull();
    expect(marketValue(quote({ hasData: false }), holding({}))).toBeNull();
    expect(marketValue(quote({ price: null }), holding({}))).toBeNull();
  });

  it('returns null on unparseable values', () => {
    expect(marketValue(quote({ price: 'abc' }), holding({}))).toBeNull();
  });
});

describe('floatPnl / floatPnlPct', () => {
  it('floatPnl = (price − unitCost) × qty', () => {
    expect(floatPnl(quote({}), holding({}))).toBeCloseTo(770, 6);
    expect(floatPnl(quote({ price: '7' }), holding({ qty: '7000', unitCost: '7.25' }))).toBeCloseTo(
      -1750,
      6,
    );
  });

  it('floatPnlPct = (price − unitCost) / unitCost', () => {
    expect(floatPnlPct(quote({}), holding({}))).toBeCloseTo(0.55 / 13.45, 9);
  });

  it('returns null when degraded / no quote / unitCost=0', () => {
    expect(floatPnl(undefined, holding({}))).toBeNull();
    expect(floatPnl(quote({}), holding({ quotable: false }))).toBeNull();
    expect(floatPnlPct(quote({}), holding({ unitCost: '0' }))).toBeNull();
  });
});

describe('summarizeHoldings', () => {
  const main = holding({});
  const second = holding({
    id: '2',
    code: 'ZQY',
    name: '合成乙科技',
    qty: '7000',
    unitCost: '7.25',
    cumPnl: '-1750.25',
  });
  const repo = holding({
    id: '3',
    code: 'ZQR',
    name: '合成逆回购',
    quotable: false,
    cumPnl: '12.5',
  });
  const quotes = new Map<string, QuoteItem>([
    ['cn:ZQX', quote({})],
    ['cn:ZQY', quote({ symbol: 'cn:ZQY', price: '7' })],
  ]);
  const quoteFor = (ref: { market: string; code: string }) =>
    quotes.get(`${ref.market}:${ref.code}`);

  it('totalMarketValue sums computable rows only (降级行剔除)', () => {
    const s = summarizeHoldings([main, second, repo], quoteFor);
    expect(s.totalMarketValue).toBeCloseTo(19600 + 49000, 6);
  });

  it('totalCumPnl sums snapshot cumPnl incl. degraded rows, skips null', () => {
    const s = summarizeHoldings(
      [main, second, repo, holding({ id: '4', code: '999999', cumPnl: null })],
      quoteFor,
    );
    expect(s.totalCumPnl).toBeCloseTo(2345.6 - 1750.25 + 12.5, 6);
  });

  it('returns nulls when nothing is computable', () => {
    expect(summarizeHoldings([], quoteFor)).toEqual({
      totalMarketValue: null,
      totalCumPnl: null,
    });
    const s = summarizeHoldings([repo], () => undefined);
    expect(s.totalMarketValue).toBeNull();
    expect(s.totalCumPnl).toBeCloseTo(12.5, 6);
  });
});

describe('groupTradesByMonth', () => {
  it('groups desc-ordered trades by YYYY-MM preserving order', () => {
    const t1 = trade({ id: '1', tradeDate: '2026-02-02' });
    const t2 = trade({ id: '2', tradeDate: '2026-01-20' });
    const t3 = trade({ id: '3', tradeDate: '2026-01-08' });
    const t4 = trade({ id: '4', tradeDate: '2025-11-06' });
    expect(groupTradesByMonth([t1, t2, t3, t4])).toEqual([
      { month: '2026-02', items: [t1] },
      { month: '2026-01', items: [t2, t3] },
      { month: '2025-11', items: [t4] },
    ]);
  });

  it('returns [] for empty input', () => {
    expect(groupTradesByMonth([])).toEqual([]);
  });
});

describe('formatAmount / formatSignedAmount', () => {
  it('adds thousands separators with fixed dp', () => {
    expect(formatAmount(2345.6)).toBe('2,345.60');
    expect(formatAmount('18830', 0)).toBe('18,830');
    expect(formatAmount(-1750.25)).toBe('-1,750.25');
    expect(formatAmount(999)).toBe('999.00');
  });

  it('returns -- for null / undefined / unparseable', () => {
    expect(formatAmount(null)).toBe('--');
    expect(formatAmount(undefined)).toBe('--');
    expect(formatAmount('--')).toBe('--');
  });

  it('signed variant prefixes + for positive only', () => {
    expect(formatSignedAmount('2345.6')).toBe('+2,345.60');
    expect(formatSignedAmount(-1750.25)).toBe('-1,750.25');
    expect(formatSignedAmount(0)).toBe('0.00');
    expect(formatSignedAmount(null)).toBe('--');
  });
});

describe('formatQty', () => {
  it('adds thousands separators and trims trailing zeros', () => {
    expect(formatQty('1400')).toBe('1,400');
    expect(formatQty('7000')).toBe('7,000');
    expect(formatQty('1234.5000')).toBe('1,234.5');
  });

  it('returns -- for null / unparseable', () => {
    expect(formatQty(null)).toBe('--');
    expect(formatQty('abc')).toBe('--');
  });
});

describe('formatRatioPct', () => {
  it('renders decimal fraction as percent (×100, 2dp)', () => {
    expect(formatRatioPct('0.1319')).toBe('13.19%');
    expect(formatRatioPct('0.0941', true)).toBe('+9.41%');
    expect(formatRatioPct('-0.0588', true)).toBe('-5.88%');
    expect(formatRatioPct(0, true)).toBe('0.00%');
  });

  it('returns -- for null / unparseable', () => {
    expect(formatRatioPct(null)).toBe('--');
    expect(formatRatioPct('--', true)).toBe('--');
  });
});

describe('pnlDirection', () => {
  it('maps sign to up/down/flat (A股 红涨绿跌 token 接 quoteColorClass)', () => {
    expect(pnlDirection(770)).toBe('up');
    expect(pnlDirection('-1750.25')).toBe('down');
    expect(pnlDirection(0)).toBe('flat');
  });

  it('maps null / undefined / NaN to none', () => {
    expect(pnlDirection(null)).toBe('none');
    expect(pnlDirection(undefined)).toBe('none');
    expect(pnlDirection('abc')).toBe('none');
  });
});
