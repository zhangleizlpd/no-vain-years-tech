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

// stub 数据沿 design/brief.md：国茂股份 603915（2000 股 / 成本 15.883 / 现价 16.43 /
// 累计盈亏 +17055.03）、杭齿前进 601177（8900 股 / 成本 15.025 / 现价 14.83）、
// GC001 204001 降级行（quotable=false）。

const holding = (over: Partial<HoldingItem>): HoldingItem => ({
  id: '1',
  market: 'cn',
  code: '603915',
  name: '国茂股份',
  qty: '2000',
  unitCost: '15.883',
  weightPct: '0.1648',
  holdDays: 5,
  cumPnl: '17055.03',
  cumPnlPct: '0.1022',
  quotable: true,
  ...over,
});

const quote = (over: Partial<QuoteItem>): QuoteItem =>
  ({
    symbol: 'cn:603915',
    hasData: true,
    price: '16.43',
    change: '0.55',
    changePct: '3.46',
    ...over,
  }) as QuoteItem;

const trade = (over: Partial<TradeItem>): TradeItem => ({
  id: '1',
  market: 'cn',
  code: '603915',
  name: '国茂股份',
  category: 'buy',
  tradeDate: '2026-06-01',
  tradeTime: '10:30:04',
  qty: '2000',
  price: '15.88',
  amount: '-31765.32',
  turnover: '31760',
  fee: '5.32',
  note: null,
  ...over,
});

describe('marketValue', () => {
  it('computes price × qty', () => {
    expect(marketValue(quote({}), holding({}))).toBeCloseTo(32860, 6);
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
    expect(floatPnl(quote({}), holding({}))).toBeCloseTo(1094, 6);
    expect(
      floatPnl(quote({ price: '14.83' }), holding({ qty: '8900', unitCost: '15.025' })),
    ).toBeCloseTo(-1735.5, 6);
  });

  it('floatPnlPct = (price − unitCost) / unitCost', () => {
    expect(floatPnlPct(quote({}), holding({}))).toBeCloseTo(0.547 / 15.883, 9);
  });

  it('returns null when degraded / no quote / unitCost=0', () => {
    expect(floatPnl(undefined, holding({}))).toBeNull();
    expect(floatPnl(quote({}), holding({ quotable: false }))).toBeNull();
    expect(floatPnlPct(quote({}), holding({ unitCost: '0' }))).toBeNull();
  });
});

describe('summarizeHoldings', () => {
  const guomao = holding({});
  const hangchi = holding({
    id: '2',
    code: '601177',
    name: '杭齿前进',
    qty: '8900',
    unitCost: '15.025',
    cumPnl: '-1739.34',
  });
  const gc001 = holding({
    id: '3',
    code: '204001',
    name: 'GC001',
    quotable: false,
    cumPnl: '12.5',
  });
  const quotes = new Map<string, QuoteItem>([
    ['cn:603915', quote({})],
    ['cn:601177', quote({ symbol: 'cn:601177', price: '14.83' })],
  ]);
  const quoteFor = (ref: { market: string; code: string }) =>
    quotes.get(`${ref.market}:${ref.code}`);

  it('totalMarketValue sums computable rows only (降级行剔除)', () => {
    const s = summarizeHoldings([guomao, hangchi, gc001], quoteFor);
    expect(s.totalMarketValue).toBeCloseTo(32860 + 131987, 6);
  });

  it('totalCumPnl sums snapshot cumPnl incl. degraded rows, skips null', () => {
    const s = summarizeHoldings(
      [guomao, hangchi, gc001, holding({ id: '4', code: '999999', cumPnl: null })],
      quoteFor,
    );
    expect(s.totalCumPnl).toBeCloseTo(17055.03 - 1739.34 + 12.5, 6);
  });

  it('returns nulls when nothing is computable', () => {
    expect(summarizeHoldings([], quoteFor)).toEqual({
      totalMarketValue: null,
      totalCumPnl: null,
    });
    const s = summarizeHoldings([gc001], () => undefined);
    expect(s.totalMarketValue).toBeNull();
    expect(s.totalCumPnl).toBeCloseTo(12.5, 6);
  });
});

describe('groupTradesByMonth', () => {
  it('groups desc-ordered trades by YYYY-MM preserving order', () => {
    const t1 = trade({ id: '1', tradeDate: '2026-06-01' });
    const t2 = trade({ id: '2', tradeDate: '2026-05-12' });
    const t3 = trade({ id: '3', tradeDate: '2026-05-11' });
    const t4 = trade({ id: '4', tradeDate: '2025-10-23' });
    expect(groupTradesByMonth([t1, t2, t3, t4])).toEqual([
      { month: '2026-06', items: [t1] },
      { month: '2026-05', items: [t2, t3] },
      { month: '2025-10', items: [t4] },
    ]);
  });

  it('returns [] for empty input', () => {
    expect(groupTradesByMonth([])).toEqual([]);
  });
});

describe('formatAmount / formatSignedAmount', () => {
  it('adds thousands separators with fixed dp', () => {
    expect(formatAmount(17055.03)).toBe('17,055.03');
    expect(formatAmount('31760', 0)).toBe('31,760');
    expect(formatAmount(-1739.34)).toBe('-1,739.34');
    expect(formatAmount(999)).toBe('999.00');
  });

  it('returns -- for null / undefined / unparseable', () => {
    expect(formatAmount(null)).toBe('--');
    expect(formatAmount(undefined)).toBe('--');
    expect(formatAmount('--')).toBe('--');
  });

  it('signed variant prefixes + for positive only', () => {
    expect(formatSignedAmount('17055.03')).toBe('+17,055.03');
    expect(formatSignedAmount(-1739.34)).toBe('-1,739.34');
    expect(formatSignedAmount(0)).toBe('0.00');
    expect(formatSignedAmount(null)).toBe('--');
  });
});

describe('formatQty', () => {
  it('adds thousands separators and trims trailing zeros', () => {
    expect(formatQty('2000')).toBe('2,000');
    expect(formatQty('7600')).toBe('7,600');
    expect(formatQty('1234.5000')).toBe('1,234.5');
  });

  it('returns -- for null / unparseable', () => {
    expect(formatQty(null)).toBe('--');
    expect(formatQty('abc')).toBe('--');
  });
});

describe('formatRatioPct', () => {
  it('renders decimal fraction as percent (×100, 2dp)', () => {
    expect(formatRatioPct('0.1648')).toBe('16.48%');
    expect(formatRatioPct('0.096', true)).toBe('+9.60%');
    expect(formatRatioPct('-0.0038', true)).toBe('-0.38%');
    expect(formatRatioPct(0, true)).toBe('0.00%');
  });

  it('returns -- for null / unparseable', () => {
    expect(formatRatioPct(null)).toBe('--');
    expect(formatRatioPct('--', true)).toBe('--');
  });
});

describe('pnlDirection', () => {
  it('maps sign to up/down/flat (A股 红涨绿跌 token 接 quoteColorClass)', () => {
    expect(pnlDirection(1094)).toBe('up');
    expect(pnlDirection('-1739.34')).toBe('down');
    expect(pnlDirection(0)).toBe('flat');
  });

  it('maps null / undefined / NaN to none', () => {
    expect(pnlDirection(null)).toBe('none');
    expect(pnlDirection(undefined)).toBe('none');
    expect(pnlDirection('abc')).toBe('none');
  });
});
