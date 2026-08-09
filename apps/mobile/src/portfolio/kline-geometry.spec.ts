import { describe, expect, it } from 'vitest';
import type { DailyBarItem } from '@nvy/api-client';

import {
  barLabel,
  buildChartGeometry,
  type Candle,
  DEFAULT_CHART_DIMS,
  downsample,
  hitTestIndex,
  ohlcLegend,
  parseBars,
  priceRange,
} from './kline-geometry';

const bar = (over: Partial<DailyBarItem>): DailyBarItem => ({
  tradeDate: '2026-06-01',
  open: '100',
  high: '110',
  low: '95',
  close: '105',
  changePct: null,
  prevClose: '98',
  volume: '1000000',
  amount: null,
  turnoverRate: null,
  ...over,
});

const candle = (over: Partial<Candle>): Candle => ({
  tradeDate: '2026-06-01',
  open: 100,
  high: 110,
  low: 95,
  close: 105,
  volume: 1_000_000,
  prevClose: 98,
  ...over,
});

describe('parseBars（string OHLCV → 数值蜡烛）', () => {
  it('解析 OHLC + volume', () => {
    const [c] = parseBars([bar({})]);
    expect(c).toMatchObject({ open: 100, high: 110, low: 95, close: 105, volume: 1_000_000 });
  });
  it('volume null → 0', () => {
    const [c] = parseBars([bar({ volume: null })]);
    expect(c?.volume).toBe(0);
  });
  it('prevClose null → null', () => {
    const [c] = parseBars([bar({ prevClose: null })]);
    expect(c?.prevClose).toBeNull();
  });
  it('OHLC 含非数 → 丢该 bar（防御脏数据）', () => {
    expect(parseBars([bar({ close: 'n/a' }), bar({})])).toHaveLength(1);
  });
  it('空 items → 空数组', () => {
    expect(parseBars([])).toEqual([]);
  });
});

describe('downsample（年 K 多年抽样，NFR）', () => {
  const mk = (n: number) => Array.from({ length: n }, (_, i) => candle({ tradeDate: `d${i}` }));
  it('length ≤ cap → 原样', () => {
    const cs = mk(10);
    expect(downsample(cs, 20)).toBe(cs);
  });
  it('length > cap → ≤ cap', () => {
    expect(downsample(mk(100), 30).length).toBeLessThanOrEqual(30);
  });
  it('必含首尾（保区间端点）', () => {
    const out = downsample(mk(100), 10);
    expect(out.at(0)?.tradeDate).toBe('d0');
    expect(out.at(-1)?.tradeDate).toBe('d99');
  });
  it('cap < 2 视为 2（至少首尾）', () => {
    expect(downsample(mk(50), 1)).toHaveLength(2);
  });
});

describe('priceRange（min low / max high + padding）', () => {
  it('区间 + 6% 上下留白', () => {
    const r = priceRange([candle({ high: 110, low: 90 })], 0.1);
    expect(r.hi).toBeCloseTo(112); // 110 + 20*0.1
    expect(r.lo).toBeCloseTo(88); // 90 - 20*0.1
  });
  it('空序列 → {0,0}', () => {
    expect(priceRange([])).toEqual({ hi: 0, lo: 0 });
  });
  it('全平 → 撑开 ±1（避免除 0）', () => {
    const r = priceRange([candle({ high: 100, low: 100 })]);
    expect(r.hi).toBe(101);
    expect(r.lo).toBe(99);
  });
});

describe('hitTestIndex（十字光标 pointer x → index）', () => {
  const dims = DEFAULT_CHART_DIMS; // plotW = 328-46 = 282
  it('x=0 → 0', () => expect(hitTestIndex(0, dims, 10)).toBe(0));
  it('负 x 夹到 0', () => expect(hitTestIndex(-50, dims, 10)).toBe(0));
  it('超右夹到 n-1', () => expect(hitTestIndex(9999, dims, 10)).toBe(9));
  it('中段映射', () => {
    // slot = 282/10 = 28.2；x=100 → floor(100/28.2)=3
    expect(hitTestIndex(100, dims, 10)).toBe(3);
  });
  it('n=0 → -1', () => expect(hitTestIndex(50, dims, 0)).toBe(-1));
});

describe('ohlcLegend（选中蜡烛 + changePct + 方向）', () => {
  const cs = [
    candle({ close: 100, open: 98 }),
    candle({ close: 110, open: 101 }),
    candle({ close: 99, open: 108 }),
  ];
  it('changePct 相对前一根 close', () => {
    expect(ohlcLegend(cs, 1)?.changePct).toBeCloseTo(10); // (110-100)/100
  });
  it('首根无前根 → changePct 0', () => {
    expect(ohlcLegend(cs, 0)?.changePct).toBe(0);
  });
  it('close>=open → up', () => expect(ohlcLegend(cs, 1)?.direction).toBe('up'));
  it('close<open → down', () => expect(ohlcLegend(cs, 2)?.direction).toBe('down'));
  it('index 越界夹紧', () => expect(ohlcLegend(cs, 99)?.candle).toBe(cs[2]));
  it('空序列 → null', () => expect(ohlcLegend([], 0)).toBeNull());
});

describe('barLabel（轴短标签）', () => {
  it('day → MM-DD', () => expect(barLabel('2026-06-01', 'day')).toBe('06-01'));
  it('week → MM-DD', () => expect(barLabel('2026-06-01', 'week')).toBe('06-01'));
  it('month → YYYY-MM', () => expect(barLabel('2026-06-01', 'month')).toBe('2026-06'));
  it('year → YYYY-MM', () => expect(barLabel('2026-06-01', 'year')).toBe('2026-06'));
});

describe('buildChartGeometry（整图几何）', () => {
  const cs = [
    candle({ open: 100, close: 105, high: 110, low: 95, volume: 1e6, tradeDate: '2026-06-01' }),
    candle({ open: 105, close: 102, high: 108, low: 100, volume: 2e6, tradeDate: '2026-06-02' }),
    candle({ open: 102, close: 112, high: 115, low: 101, volume: 3e6, tradeDate: '2026-06-03' }),
  ];
  const g = buildChartGeometry(cs, 'day');

  it('蜡烛数与输入一致', () => expect(g.candles).toHaveLength(3));
  it('涨跌方向（close>=open=up）', () => {
    expect(g.candles.map((c) => c.direction)).toEqual(['up', 'down', 'up']);
  });
  it('实体高 ≥ 1', () => {
    g.candles.forEach((c) => expect(c.bodyH).toBeGreaterThanOrEqual(1));
  });
  it('影线高点 y < 低点 y（high 在上，y 向下）', () => {
    g.candles.forEach((c) => expect(c.wickY1).toBeLessThan(c.wickY2));
  });
  it('量柱高 ≥ 0 且不超副图高', () => {
    g.candles.forEach((c) => {
      expect(c.volBarH).toBeGreaterThanOrEqual(0);
      expect(c.volBarH).toBeLessThanOrEqual(DEFAULT_CHART_DIMS.volH);
    });
  });
  it('最大量柱最高（vmax 归一）', () => {
    const heights = g.candles.map((c) => c.volBarH);
    expect(heights[2]).toBeGreaterThan(heights[0] ?? 0);
  });
  it('价轴刻度 = gridLines + 1', () => expect(g.priceTicks).toHaveLength(5));
  it('日期轴 4 点（首/1-3/2-3/尾，去重）', () => {
    expect(g.dateTicks.length).toBeLessThanOrEqual(4);
    expect(g.dateTicks.at(0)?.label).toBe('06-01');
  });
  it('空序列 → 空几何', () => {
    const e = buildChartGeometry([], 'day');
    expect(e.candles).toEqual([]);
    expect(e.priceTicks).toEqual([]);
  });
});
