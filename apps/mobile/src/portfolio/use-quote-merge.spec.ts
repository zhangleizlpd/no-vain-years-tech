import { describe, expect, it, vi } from 'vitest';
import type { QuoteItem } from '@nvy/api-client';

// 纯函数单测：mock @nvy/api-client（其 dist entry 在 vitest 不可解析；orval runtime hook
// 仅编排用，被测纯函数不触达）。镜像 use-market-preferences.spec —— 仅 stub 本 impl 引入的 hook。
vi.mock('@nvy/api-client', () => ({
  useMarketdataControllerQuote: vi.fn(),
}));

import {
  buildSymbols,
  formatChange,
  formatPct,
  formatPrice,
  indexQuotes,
  quoteColorClass,
  quoteDirection,
  symbolOf,
} from './use-quote-merge';

const q = (over: Partial<QuoteItem>): QuoteItem => ({
  symbol: 'cn:600519',
  name: '贵州茅台',
  price: '100.00',
  change: '1.00',
  changePct: '1.00',
  asOf: '2026-06-03',
  priceKind: 'eod_close',
  hasData: true,
  ...over,
});

describe('quoteDirection (涨跌方向, A股 红涨绿跌)', () => {
  it('changePct > 0 → up', () => {
    expect(quoteDirection(q({ changePct: '1.23' }))).toBe('up');
  });
  it('changePct < 0 → down', () => {
    expect(quoteDirection(q({ changePct: '-2.10' }))).toBe('down');
  });
  it('changePct === 0 → flat', () => {
    expect(quoteDirection(q({ changePct: '0.00' }))).toBe('flat');
  });
  it('undefined quote → none (未就位)', () => {
    expect(quoteDirection(undefined)).toBe('none');
  });
  it('hasData=false → none (显式无数据)', () => {
    expect(quoteDirection(q({ hasData: false }))).toBe('none');
  });
  it('changePct null → none', () => {
    expect(quoteDirection(q({ changePct: null }))).toBe('none');
  });
});

describe('quoteColorClass (方向 → quote token class)', () => {
  it('up → text-quote-up', () => expect(quoteColorClass('up')).toBe('text-quote-up'));
  it('down → text-quote-down', () => expect(quoteColorClass('down')).toBe('text-quote-down'));
  it('flat → text-quote-flat', () => expect(quoteColorClass('flat')).toBe('text-quote-flat'));
  it('none → 中性灰占位 text-ink-subtle', () =>
    expect(quoteColorClass('none')).toBe('text-ink-subtle'));
});

describe('格式化 (带符号 → a11y 色盲友好)', () => {
  it('formatPct 涨 带 + 号 + %', () => expect(formatPct(q({ changePct: '1.2' }))).toBe('+1.20%'));
  it('formatPct 跌 带 - 号', () => expect(formatPct(q({ changePct: '-3.456' }))).toBe('-3.46%'));
  it('formatPct 无数据 → --', () => expect(formatPct(q({ hasData: false }))).toBe('--'));
  it('formatChange 涨 带 + 号 无 %', () =>
    expect(formatChange(q({ change: '0.5' }))).toBe('+0.50'));
  it('formatChange null → --', () => expect(formatChange(q({ change: null }))).toBe('--'));
  it('formatPrice 无符号', () => expect(formatPrice(q({ price: '1689' }))).toBe('1689.00'));
  it('formatPrice null → --', () => expect(formatPrice(q({ price: null }))).toBe('--'));
});

describe('buildSymbols / indexQuotes / symbolOf', () => {
  it('symbolOf → market:code', () => {
    expect(symbolOf({ market: 'hk', code: '00700' })).toBe('hk:00700');
  });
  it('buildSymbols 去重 + 逗号分隔', () => {
    const refs = [
      { market: 'cn', code: '600519' } as const,
      { market: 'cn', code: '600519' } as const,
      { market: 'hk', code: '00700' } as const,
    ];
    expect(buildSymbols(refs)).toBe('cn:600519,hk:00700');
  });
  it('buildSymbols 空 → 空串', () => expect(buildSymbols([])).toBe(''));
  it('indexQuotes 按 symbol 建索引 (同 symbol 取首条)', () => {
    const map = indexQuotes({
      items: [q({ symbol: 'cn:1', price: '1' }), q({ symbol: 'cn:1', price: '2' })],
    });
    expect(map.get('cn:1')?.price).toBe('1');
  });
  it('indexQuotes undefined → 空 map', () => expect(indexQuotes(undefined).size).toBe(0));
});
