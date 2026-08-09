import { describe, expect, it } from 'vitest';
import {
  boll,
  kdj,
  macd,
  movingAverage,
  newHighLow,
  periodReturnPct,
  rsi,
  volumeRatio,
  type IndicatorBar,
} from './alert-indicator.rules.js';

/** 最小 bar 工厂: 只关心被测字段, 其余给中性默认 (升序 tradeDate 由数组顺序保证)。 */
function bar(o: Partial<IndicatorBar> & { close: number }): IndicatorBar {
  return {
    tradeDate: '2026-01-01',
    open: o.close,
    high: o.high ?? o.close,
    low: o.low ?? o.close,
    close: o.close,
    prevClose: o.prevClose ?? null,
    volume: o.volume ?? null,
    turnoverRate: o.turnoverRate ?? null,
  };
}

const closes = (...cs: number[]): IndicatorBar[] => cs.map((c) => bar({ close: c }));

describe('movingAverage (MA 今昨双值)', () => {
  it('len>period: 今昨双值手算锚定', () => {
    const r = movingAverage(closes(10, 11, 12, 13, 14), 3);
    expect(r).not.toBeNull();
    expect(r!.today).toBeCloseTo(13, 10); // (12+13+14)/3
    expect(r!.yesterday).toBeCloseTo(12, 10); // (11+12+13)/3
  });

  it('len===period (边界): 今值算、昨值 null', () => {
    const r = movingAverage(closes(10, 11, 12), 3);
    expect(r!.today).toBeCloseTo(11, 10); // (10+11+12)/3
    expect(r!.yesterday).toBeNull();
  });

  it('len<period (warm-up): null', () => {
    expect(movingAverage(closes(10, 11), 3)).toBeNull();
  });
});

describe('newHighLow (N 日新高低, 不含今日)', () => {
  const bars: IndicatorBar[] = [
    bar({ close: 10, high: 10, low: 8 }),
    bar({ close: 11, high: 12, low: 9 }),
    bar({ close: 10, high: 11, low: 7 }),
    bar({ close: 13, high: 13, low: 6 }), // today
  ];

  it('window=3: 前 3 日极值 + 今日穿越数据', () => {
    const r = newHighLow(bars, 3);
    expect(r).not.toBeNull();
    expect(r!.priorHigh).toBe(12); // max(10,12,11)
    expect(r!.priorLow).toBe(7); // min(8,9,7)
    expect(r!.todayHigh).toBe(13); // > priorHigh → 新高
    expect(r!.todayLow).toBe(6); // < priorLow → 新低
  });

  it('len===window (边界, 前置仅 N-1 根): null', () => {
    expect(newHighLow(bars.slice(0, 3), 3)).toBeNull();
  });
});

describe('periodReturnPct (N 交易日累计涨跌幅 %)', () => {
  it('days=3: (今收−3日前收)/3日前收 ×100', () => {
    // close[len-1-3]=100, today=110 → +10%
    expect(periodReturnPct(closes(100, 101, 102, 110), 3)).toBeCloseTo(10, 10);
  });

  it('负向涨跌幅保留符号', () => {
    expect(periodReturnPct(closes(100, 99, 98, 90), 3)).toBeCloseTo(-10, 10);
  });

  it('len===days (边界): null', () => {
    expect(periodReturnPct(closes(100, 101, 102), 3)).toBeNull();
  });

  it('N 日前收 ≤0 (除零防御): null', () => {
    expect(periodReturnPct(closes(0, 1, 2, 3), 3)).toBeNull();
  });
});

describe('volumeRatio (今量 / 前 5 日均量)', () => {
  const vols = (...vs: number[]): IndicatorBar[] => vs.map((v) => bar({ close: 1, volume: v }));

  it('window=5: 今量/前5日均量', () => {
    // 前 5 日 [10,20,30,40,50] avg=30, 今量 120 → 4.0
    expect(volumeRatio(vols(10, 20, 30, 40, 50, 120), 5)).toBeCloseTo(4, 10);
  });

  it('len===window (边界, 仅 5 根无今日外前置): null', () => {
    expect(volumeRatio(vols(10, 20, 30, 40, 50), 5)).toBeNull();
  });

  it('窗口内任一量 null: null', () => {
    const bars = [
      bar({ close: 1, volume: 10 }),
      bar({ close: 1, volume: null }),
      bar({ close: 1, volume: 30 }),
      bar({ close: 1, volume: 40 }),
      bar({ close: 1, volume: 50 }),
      bar({ close: 1, volume: 120 }),
    ];
    expect(volumeRatio(bars, 5)).toBeNull();
  });

  it('今量 null: null', () => {
    const bars = [...vols(10, 20, 30, 40, 50), bar({ close: 1, volume: null })];
    expect(volumeRatio(bars, 5)).toBeNull();
  });
});

// ── T010: 递推指标 (小周期干净数列手算锚定 + 不变量; 生产固定周期由 SC-002 真样本兜) ──

describe('macd (DIF/DEA 今昨双值)', () => {
  it('手算锚定 fast=2/slow=3/signal=2, close=[3,6,9]', () => {
    // emaFast(2)=[3,5,7.6667] emaSlow(3)=[3,4.5,6.75] dif=[0,0.5,0.91667]
    // dea=EMA(dif,2)=[0,0.33333,0.72222]
    const r = macd(closes(3, 6, 9), 2, 3, 2);
    expect(r).not.toBeNull();
    expect(r!.dif.today).toBeCloseTo(0.916667, 5);
    expect(r!.dif.yesterday!).toBeCloseTo(0.5, 5);
    expect(r!.dea.today).toBeCloseTo(0.722222, 5);
    expect(r!.dea.yesterday!).toBeCloseTo(0.333333, 5);
  });

  it('恒定序列 → DIF=DEA=0 (不变量)', () => {
    const r = macd(closes(10, 10, 10, 10, 10));
    expect(r!.dif.today).toBeCloseTo(0, 10);
    expect(r!.dea.today).toBeCloseTo(0, 10);
  });

  it('len<2: null', () => {
    expect(macd(closes(10))).toBeNull();
  });
});

describe('kdj (K/D/J 今昨双值)', () => {
  const hlc = (high: number, low: number, close: number): IndicatorBar => bar({ close, high, low });

  it('手算锚定 n=2', () => {
    // b: (H,L,C) → rsv(n=2)=[50,75,20]; K=SMA(.,3,1)/50=[50,58.333,45.556]
    // D=[50,52.778,50.370]; J=3K-2D
    const r = kdj([hlc(10, 8, 9), hlc(12, 9, 11), hlc(11, 7, 8)], 2);
    expect(r).not.toBeNull();
    expect(r!.k.today).toBeCloseTo(45.5556, 3);
    expect(r!.d.today).toBeCloseTo(50.3704, 3);
    expect(r!.j.today).toBeCloseTo(35.9259, 3); // 3*45.5556 - 2*50.3704
    expect(r!.k.yesterday!).toBeCloseTo(58.3333, 3);
    expect(r!.j.yesterday!).toBeCloseTo(69.4444, 3);
  });

  it('HHV==LLV (平盘) → RSV=0 不抛', () => {
    const r = kdj([hlc(5, 5, 5), hlc(5, 5, 5)], 2);
    expect(r).not.toBeNull();
    expect(Number.isFinite(r!.j.today)).toBe(true);
  });
});

describe('rsi (Wilder 1/N 递推)', () => {
  it('手算锚定 period=2, close=[10,11,9,12]', () => {
    // diff=[+1,-2,+3] up=[1,0,3] dn=[1,2,3]
    // smu=[1,0.5,1.75] smd=[1,1.5,2.25] rsi=[100,33.333,77.778]
    const r = rsi(closes(10, 11, 9, 12), 2);
    expect(r).not.toBeNull();
    expect(r!.today).toBeCloseTo(77.7778, 3);
    expect(r!.yesterday!).toBeCloseTo(33.3333, 3);
  });

  it('单调上涨 → RSI=100 (无下跌, 不变量)', () => {
    expect(rsi(closes(1, 2, 3, 4, 5), 14)!.today).toBeCloseTo(100, 6);
  });

  it('len<3: null', () => {
    expect(rsi(closes(10, 11), 14)).toBeNull();
  });
});

describe('boll (MID/UP/DN 今昨双值, 样本标准差)', () => {
  it('手算锚定 period=3/mult=2, close=[2,4,6,8]', () => {
    // i2 win[2,4,6]: mid=4 std=2 → up8 dn0; i3 win[4,6,8]: mid=6 std=2 → up10 dn2
    const r = boll(closes(2, 4, 6, 8), 3, 2);
    expect(r).not.toBeNull();
    expect(r!.mid.today).toBeCloseTo(6, 10);
    expect(r!.upper.today).toBeCloseTo(10, 10);
    expect(r!.lower.today).toBeCloseTo(2, 10);
    expect(r!.mid.yesterday!).toBeCloseTo(4, 10);
    expect(r!.upper.yesterday!).toBeCloseTo(8, 10);
    expect(r!.lower.yesterday!).toBeCloseTo(0, 10);
  });

  it('len===period (边界): 今值算、昨值 null', () => {
    const r = boll(closes(2, 4, 6), 3, 2);
    expect(r!.mid.today).toBeCloseTo(4, 10);
    expect(r!.mid.yesterday).toBeNull();
  });

  it('len<period: null', () => {
    expect(boll(closes(2, 4), 3, 2)).toBeNull();
  });
});
