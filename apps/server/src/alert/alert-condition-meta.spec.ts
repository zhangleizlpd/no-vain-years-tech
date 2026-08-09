import { describe, expect, it } from 'vitest';
import {
  ALERT_CONDITION_CATEGORIES,
  ALERT_CONDITION_KINDS,
  ALERT_CONDITION_META,
  ALERT_CONDITION_TYPES,
  INDICATOR_PARAMS,
  KDJ_OVERBOUGHT_J,
  KDJ_OVERSOLD_J,
  MA_PERIODS,
  NO_PARAM_SENTINEL,
  PCTL_YEARS,
  PERIOD_DAYS,
  WINDOW_DAYS,
  isThresholdInRange,
  metaOf,
} from './alert-condition-meta.js';

describe('alert-condition-meta (023 词表 SoT)', () => {
  it('词表完整性：34 type 全枚举、无重复、每 type 有 meta 且 key 自洽', () => {
    expect(ALERT_CONDITION_TYPES).toHaveLength(34);
    expect(new Set(ALERT_CONDITION_TYPES).size).toBe(34);
    for (const type of ALERT_CONDITION_TYPES) {
      const meta = ALERT_CONDITION_META[type];
      expect(meta, `meta missing for ${type}`).toBeDefined();
      expect(meta.type).toBe(type);
      expect(metaOf(type)).toBe(meta);
      // DB 列宽护栏 (migration 同步放宽 VarChar(32))
      expect(type.length).toBeLessThanOrEqual(32);
    }
  });

  it('分类分组：4 分类 × 数量 (024 起价格 12：023 的 10 + 盘中 5min 涨/跌超 2)', () => {
    expect(ALERT_CONDITION_CATEGORIES).toEqual(['price', 'valuation', 'volume', 'technical']);
    const countBy = (cat: string) =>
      ALERT_CONDITION_TYPES.filter((t) => ALERT_CONDITION_META[t].category === cat).length;
    expect(countBy('price')).toBe(12);
    expect(countBy('valuation')).toBe(10);
    expect(countBy('volume')).toBe(2);
    expect(countBy('technical')).toBe(10);
  });

  it('021 既有 4 type 形态不变 (FR-S09：kind=threshold / 无参 / 值域族沿旧)', () => {
    expect(ALERT_CONDITION_TYPES.slice(0, 4)).toEqual([
      'PRICE_RISE_TO',
      'PRICE_FALL_TO',
      'DAILY_GAIN_OVER',
      'DAILY_LOSS_OVER',
    ]);
    for (const type of ['PRICE_RISE_TO', 'PRICE_FALL_TO'] as const) {
      const m = ALERT_CONDITION_META[type];
      expect(m.kind).toBe('threshold');
      expect(m.paramWhitelist).toEqual([]);
      expect(m.thresholdFamily).toBe('price');
      expect(m.unit).toBe('元');
    }
    for (const type of ['DAILY_GAIN_OVER', 'DAILY_LOSS_OVER'] as const) {
      const m = ALERT_CONDITION_META[type];
      expect(m.kind).toBe('threshold');
      expect(m.paramWhitelist).toEqual([]);
      expect(m.thresholdFamily).toBe('percent');
      expect(m.unit).toBe('%');
    }
  });

  it('kind × 形态不变量：param 白名单 ⟺ kind ∈ {ma,window,daysPct,pctile}；threshold 禁带 ⟺ family null', () => {
    expect(ALERT_CONDITION_KINDS).toEqual([
      'threshold',
      'ma',
      'window',
      'daysPct',
      'pctile',
      'rsi',
      'none',
    ]);
    const PARAM_KINDS = ['ma', 'window', 'daysPct', 'pctile'];
    for (const type of ALERT_CONDITION_TYPES) {
      const m = ALERT_CONDITION_META[type];
      // param 白名单非空 ⟺ 带参 kind
      expect(m.paramWhitelist.length > 0, `${type} param/kind 互斥`).toBe(
        PARAM_KINDS.includes(m.kind),
      );
      // threshold 形态：none/ma/window 禁带，其余必带
      const forbidsThreshold = ['none', 'ma', 'window'].includes(m.kind);
      expect(m.thresholdFamily === null, `${type} threshold/kind 互斥`).toBe(forbidsThreshold);
      // defaultThreshold 仅 rsi kind 且在值域内
      if (m.defaultThreshold !== undefined) {
        expect(m.kind).toBe('rsi');
        expect(isThresholdInRange(m.thresholdFamily!, m.defaultThreshold)).toBe(true);
      }
    }
  });

  it('param 白名单常量：升序正整数、不含 sentinel 0、按 kind 对号', () => {
    expect(NO_PARAM_SENTINEL).toBe(0);
    expect(MA_PERIODS).toEqual([5, 10, 20, 60, 120, 250]);
    expect(WINDOW_DAYS).toEqual([60, 120, 250]);
    expect(PERIOD_DAYS).toEqual([3, 5, 10]);
    expect(PCTL_YEARS).toEqual([3, 5]);
    const byKind: Record<string, readonly number[]> = {
      ma: MA_PERIODS,
      window: WINDOW_DAYS,
      daysPct: PERIOD_DAYS,
      pctile: PCTL_YEARS,
    };
    for (const type of ALERT_CONDITION_TYPES) {
      const m = ALERT_CONDITION_META[type];
      if (m.paramWhitelist.length > 0) {
        expect(m.paramWhitelist).toEqual(byKind[m.kind]);
        expect(m.paramWhitelist).not.toContain(NO_PARAM_SENTINEL);
      }
    }
  });

  it('threshold 值域族 (FR-S07)：price>0 / percent(0,100] / positive>0 / pctile[0,100] / rsi(0,100)', () => {
    // price / positive: >0
    for (const family of ['price', 'positive'] as const) {
      expect(isThresholdInRange(family, 0)).toBe(false);
      expect(isThresholdInRange(family, 0.01)).toBe(true);
      expect(isThresholdInRange(family, 99999)).toBe(true);
      expect(isThresholdInRange(family, Number.NaN)).toBe(false);
    }
    // percent: (0,100]
    expect(isThresholdInRange('percent', 0)).toBe(false);
    expect(isThresholdInRange('percent', 100)).toBe(true);
    expect(isThresholdInRange('percent', 100.01)).toBe(false);
    // pctile: [0,100] 闭区间
    expect(isThresholdInRange('pctile', 0)).toBe(true);
    expect(isThresholdInRange('pctile', 100)).toBe(true);
    expect(isThresholdInRange('pctile', -0.01)).toBe(false);
    expect(isThresholdInRange('pctile', 100.01)).toBe(false);
    // rsi: (0,100) 开区间
    expect(isThresholdInRange('rsi', 0)).toBe(false);
    expect(isThresholdInRange('rsi', 100)).toBe(false);
    expect(isThresholdInRange('rsi', 0.01)).toBe(true);
    expect(isThresholdInRange('rsi', 99.99)).toBe(true);
  });

  it('值域族对号：换手率/PE/PB/量比 = positive(FR-S07 仅 ≤0 拒)；股息率/累计涨跌 = percent；分位 = pctile', () => {
    const familyOf = (t: (typeof ALERT_CONDITION_TYPES)[number]) =>
      ALERT_CONDITION_META[t].thresholdFamily;
    for (const t of [
      'PE_ABOVE',
      'PE_BELOW',
      'PB_ABOVE',
      'PB_BELOW',
      'VOLUME_RATIO_OVER',
      'TURNOVER_RATE_OVER',
    ] as const) {
      expect(familyOf(t), t).toBe('positive');
    }
    for (const t of [
      'DIVIDEND_YIELD_ABOVE',
      'DIVIDEND_YIELD_BELOW',
      'PERIOD_GAIN_OVER',
      'PERIOD_LOSS_OVER',
    ] as const) {
      expect(familyOf(t), t).toBe('percent');
    }
    for (const t of ['PE_PCTL_ABOVE', 'PE_PCTL_BELOW', 'PB_PCTL_ABOVE', 'PB_PCTL_BELOW'] as const) {
      expect(familyOf(t), t).toBe('pctile');
    }
  });

  it('RSI 双 type：rsi kind + 默认 70/30 (FR-S04)', () => {
    expect(ALERT_CONDITION_META.RSI_OVERBOUGHT.kind).toBe('rsi');
    expect(ALERT_CONDITION_META.RSI_OVERBOUGHT.defaultThreshold).toBe(70);
    expect(ALERT_CONDITION_META.RSI_OVERSOLD.kind).toBe('rsi');
    expect(ALERT_CONDITION_META.RSI_OVERSOLD.defaultThreshold).toBe(30);
  });

  it('无参技术指标 8 type = none kind (金叉死叉×4 / KDJ 超买卖×2 / BOLL×2)', () => {
    for (const t of [
      'MACD_GOLDEN_CROSS',
      'MACD_DEATH_CROSS',
      'KDJ_GOLDEN_CROSS',
      'KDJ_DEATH_CROSS',
      'KDJ_OVERBOUGHT',
      'KDJ_OVERSOLD',
      'BOLL_BREAK_UPPER',
      'BOLL_BREAK_LOWER',
    ] as const) {
      expect(ALERT_CONDITION_META[t].kind, t).toBe('none');
      expect(ALERT_CONDITION_META[t].category, t).toBe('technical');
    }
  });

  it('通达信公式常量 (plan D5)：MACD(12,26,9) / KDJ(9,3,3) / RSI(14) / BOLL(20,2σ)；KDJ 超买 J>100 / 超卖 J<10', () => {
    expect(INDICATOR_PARAMS.MACD).toEqual({ fast: 12, slow: 26, signal: 9 });
    expect(INDICATOR_PARAMS.KDJ).toEqual({ n: 9, k: 3, d: 3 });
    expect(INDICATOR_PARAMS.RSI).toEqual({ n: 14 });
    expect(INDICATOR_PARAMS.BOLL).toEqual({ n: 20, k: 2 });
    expect(KDJ_OVERBOUGHT_J).toBe(100);
    expect(KDJ_OVERSOLD_J).toBe(10);
  });

  it('024 盘中 2 新 type：5min 涨/跌超 = threshold + percent(0,100] + % + 无参 (param 必 0)', () => {
    for (const t of ['PRICE_RISE_5MIN_OVER', 'PRICE_FALL_5MIN_OVER'] as const) {
      const m = ALERT_CONDITION_META[t];
      expect(m, t).toBeDefined();
      expect(m.category, t).toBe('price');
      expect(m.kind, t).toBe('threshold');
      expect(m.paramWhitelist, t).toEqual([]);
      expect(m.thresholdFamily, t).toBe('percent');
      expect(m.unit, t).toBe('%');
      // (0,100] 值域：0 拒 / 3 接受 / 100 接受 / >100 拒
      expect(isThresholdInRange(m.thresholdFamily!, 0)).toBe(false);
      expect(isThresholdInRange(m.thresholdFamily!, 3)).toBe(true);
      expect(isThresholdInRange(m.thresholdFamily!, 100)).toBe(true);
      expect(isThresholdInRange(m.thresholdFamily!, 100.01)).toBe(false);
    }
  });

  it('024 intradayEligible：恰 4 type 为 true (到价 2 + 盘中 5min 2)，其余 30 为 false', () => {
    const eligible = ALERT_CONDITION_TYPES.filter((t) => ALERT_CONDITION_META[t].intradayEligible);
    expect(new Set(eligible)).toEqual(
      new Set(['PRICE_RISE_TO', 'PRICE_FALL_TO', 'PRICE_RISE_5MIN_OVER', 'PRICE_FALL_5MIN_OVER']),
    );
    // 每 type intradayEligible 必为显式 boolean (无 undefined 漏填)
    for (const t of ALERT_CONDITION_TYPES) {
      expect(typeof ALERT_CONDITION_META[t].intradayEligible, t).toBe('boolean');
    }
  });
});
