import { describe, expect, it } from 'vitest';
import {
  aggregateBars,
  changeFromPct,
  computeChange,
  decimalToString,
  fiftyTwoWeekHighLow,
} from './marketdata.rules.js';
import type { EodBarPoint } from './marketdata.types.js';

function bar(
  tradeDate: string,
  o: string,
  h: string,
  l: string,
  c: string,
  partial: Partial<EodBarPoint> = {},
): EodBarPoint {
  return {
    tradeDate,
    adjust: 'none',
    open: o,
    high: h,
    low: l,
    close: c,
    changePct: null,
    prevClose: null,
    volume: null,
    amount: null,
    turnoverRate: null,
    ...partial,
  };
}

describe('marketdata.rules — computeChange (前收算涨跌)', () => {
  it('change = close-prevClose, changePct = change/prevClose*100, 4dp string', () => {
    // 茅台 fixture 口径: 1700 vs 前收 1690 → +10 / +0.5917%
    expect(computeChange('1700.0000', '1690.0000')).toEqual({
      change: '10.0000',
      changePct: '0.5917',
    });
  });

  it('下跌为负值', () => {
    expect(computeChange('1680', '1700')).toEqual({ change: '-20.0000', changePct: '-1.1765' });
  });

  it('close 或 prevClose 缺 → 双 null (不伪造涨跌)', () => {
    expect(computeChange('1700', null)).toEqual({ change: null, changePct: null });
    expect(computeChange(null, '1690')).toEqual({ change: null, changePct: null });
  });

  it('prevClose=0 → change 可算, changePct 除零保护置 null', () => {
    expect(computeChange('5', '0')).toEqual({ change: '5.0000', changePct: null });
  });
});

describe('marketdata.rules — changeFromPct (官方涨跌幅反推涨跌额, 3b 终局)', () => {
  it('普通日: 由官方涨跌幅反推涨跌额, 与相邻收盘差一致', () => {
    // 杭齿前进 2026-06-11: close 13.22, 官方 -2.15% → 昨收 13.51, 涨跌额 -0.29。
    expect(changeFromPct('13.2200', '-2.1500')).toEqual({
      change: '-0.2905',
      changePct: '-2.1500',
    });
  });

  it('除权日: 官方涨跌幅 ≠ 相邻收盘差 (决定性 — 茅台 2025-06-26 分红除息)', () => {
    // 官方 +0.83% (实际上涨); raw 相邻收盘差 = (1420-1435.86)/1435.86 = -1.10% (方向都反)。
    // changeFromPct 用官方值 → 昨收 = 1420/1.0083 = 1408.31, 涨跌额 +11.69 (正, 与同花顺一致)。
    expect(changeFromPct('1420.0000', '0.8300')).toEqual({
      change: '11.6890',
      changePct: '0.8300',
    });
    // 对照: raw lag (computeChange vs 相邻原始收盘 1435.86) 会算出负值 — 错。
    expect(computeChange('1420.0000', '1435.8600').change).toBe('-15.8600');
  });

  it('close 或 changePct 缺 → 双 null (无官方值不伪造)', () => {
    expect(changeFromPct('1700', null)).toEqual({ change: null, changePct: null });
    expect(changeFromPct(null, '0.5917')).toEqual({ change: null, changePct: null });
  });

  it('changePct=0 → 涨跌额 0 (平盘, 昨收=今收)', () => {
    expect(changeFromPct('13.2200', '0')).toEqual({ change: '0.0000', changePct: '0.0000' });
  });
});

describe('marketdata.rules — decimalToString', () => {
  it('统一 4dp; null 透传', () => {
    expect(decimalToString('1700')).toBe('1700.0000');
    expect(decimalToString(null)).toBeNull();
  });
});

describe('marketdata.rules — fiftyTwoWeekHighLow (近 252 日 max/min close)', () => {
  it('空序列 → 双 null', () => {
    expect(fiftyTwoWeekHighLow([])).toEqual({ high: null, low: null });
  });

  it('取 close 的 max/min, 与顺序无关', () => {
    const bars = [
      bar('2026-01-02', '10', '11', '9', '10'),
      bar('2026-01-03', '10', '13', '9', '12.5'),
      bar('2026-01-04', '10', '11', '7', '8'),
    ];
    expect(fiftyTwoWeekHighLow(bars)).toEqual({ high: '12.5000', low: '8.0000' });
  });

  it('仅取末 252 个交易日 (更早的高点不计入)', () => {
    const old = bar('2024-01-01', '0', '0', '0', '9999'); // 远古超高点, 应被裁掉
    const recent = Array.from({ length: 252 }, (_, i) =>
      bar(
        `2026-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
        '10',
        '10',
        '10',
        '50',
      ),
    );
    const { high } = fiftyTwoWeekHighLow([old, ...recent]);
    expect(high).toBe('50.0000');
  });
});

describe('marketdata.rules — aggregateBars (period 聚合)', () => {
  const week1 = [
    bar('2026-06-01', '10', '12', '9', '11', { volume: '100', amount: '1000', prevClose: '9.5' }), // 周一
    bar('2026-06-03', '11', '15', '8', '14', { volume: '200', amount: '2000' }), // 周三
    bar('2026-06-05', '14', '14', '13', '13', { volume: '50', amount: '500' }), // 周五
  ];
  const week2 = [bar('2026-06-08', '13', '20', '12', '19', { volume: '30', amount: '300' })]; // 次周一

  it("period='day' 原样返回 (deep copy 非别名)", () => {
    const out = aggregateBars(week1, 'day');
    expect(out).toHaveLength(3);
    expect(out[0]).not.toBe(week1[0]);
    expect(out[0].close).toBe('11');
  });

  it('week: 首开/最高/最低/末收 + 量和; changePct=期间收益; prevClose=桶首官方昨收; turnoverRate=null', () => {
    const out = aggregateBars([...week1, ...week2], 'week');
    expect(out).toHaveLength(2);
    const [w1, w2] = out;
    expect(w1).toMatchObject({
      tradeDate: '2026-06-05', // 桶内末交易日
      open: '10',
      high: '15',
      low: '8',
      close: '13',
      volume: '350',
      amount: '3500',
      // 期间收益: 期末收 13 vs 桶首官方昨收 9.5 → +36.8421%; prevClose 归一 4dp。
      changePct: '36.8421',
      prevClose: '9.5000',
      turnoverRate: null,
    });
    expect(w2.tradeDate).toBe('2026-06-08');
    expect(w2.close).toBe('19');
    // week2 单 bar 无 stored 前收 + changePct 缺 → 期间涨跌不可算 (双 null, 不伪造)。
    expect(w2.changePct).toBeNull();
    expect(w2.prevClose).toBeNull();
  });

  it('month / quarter / year 分桶', () => {
    const bars = [
      bar('2026-01-15', '1', '2', '1', '2', { volume: '10' }),
      bar('2026-03-20', '2', '5', '2', '4', { volume: '20' }),
      bar('2026-07-10', '4', '6', '3', '6', { volume: '30' }),
    ];
    expect(aggregateBars(bars, 'month')).toHaveLength(3);
    const q = aggregateBars(bars, 'quarter');
    expect(q).toHaveLength(2); // Q1(1月+3月) + Q3(7月)
    expect(q[0]).toMatchObject({ open: '1', high: '5', close: '4', volume: '30' });
    expect(aggregateBars(bars, 'year')).toHaveLength(1);
  });

  it('空区间 → 空数组', () => {
    expect(aggregateBars([], 'week')).toEqual([]);
  });

  it('volume/amount 全 null → 聚合保持 null (不强转 0)', () => {
    const out = aggregateBars(
      [bar('2026-06-01', '1', '1', '1', '1'), bar('2026-06-02', '1', '1', '1', '1')],
      'week',
    );
    expect(out[0].volume).toBeNull();
    expect(out[0].amount).toBeNull();
  });
});
