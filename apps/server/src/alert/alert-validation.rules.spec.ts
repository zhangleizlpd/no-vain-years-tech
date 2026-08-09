import { describe, expect, it } from 'vitest';
import { ALERT_CONDITION_TYPES as META_TYPES } from './alert-condition-meta.js';
import {
  ALERT_CONDITION_TYPES,
  ALERT_FREQUENCIES,
  ALERT_MARKETS,
  MAX_ALERT_CONDITIONS,
  MAX_NOTE_CODE_POINTS,
  noteCodePoints,
  validateAlertDraft,
  type AlertDraftInput,
} from './alert-validation.rules.js';

function draft(overrides: Partial<AlertDraftInput> = {}): AlertDraftInput {
  return {
    market: 'cn',
    conditions: [{ type: 'PRICE_FALL_TO', threshold: 13 }],
    frequency: 'DAILY',
    note: null,
    ...overrides,
  };
}

function codes(input: AlertDraftInput): string[] {
  return validateAlertDraft(input).map((e) => e.code);
}

describe('alert-validation.rules', () => {
  // 词表演进：4 → 32 (023 meta 单源) → 34 (024 +2 盘中)；021 4 type 居首形态不变 (FR-S09)
  it('词表常量形态 (024: 34 type from meta 单源)', () => {
    expect(ALERT_MARKETS).toEqual(['cn']);
    expect(ALERT_CONDITION_TYPES).toBe(META_TYPES);
    expect(ALERT_CONDITION_TYPES).toHaveLength(34);
    expect(ALERT_CONDITION_TYPES.slice(0, 4)).toEqual([
      'PRICE_RISE_TO',
      'PRICE_FALL_TO',
      'DAILY_GAIN_OVER',
      'DAILY_LOSS_OVER',
    ]);
    expect(ALERT_FREQUENCIES).toEqual(['ONCE_DELETE', 'ONCE_DISABLE', 'DAILY']);
    expect(MAX_ALERT_CONDITIONS).toBe(4);
    expect(MAX_NOTE_CODE_POINTS).toBe(22);
  });

  describe('conditions 1..4 (FR-S02)', () => {
    it('0 条 → ALERT_CONDITIONS_EMPTY', () => {
      expect(codes(draft({ conditions: [] }))).toEqual(['ALERT_CONDITIONS_EMPTY']);
    });

    it('4 条全类型 → 合法', () => {
      expect(
        codes(
          draft({
            conditions: [
              { type: 'PRICE_RISE_TO', threshold: 20 },
              { type: 'PRICE_FALL_TO', threshold: 13 },
              { type: 'DAILY_GAIN_OVER', threshold: 5 },
              { type: 'DAILY_LOSS_OVER', threshold: 7 },
            ],
          }),
        ),
      ).toEqual([]);
    });

    it('5 条 → ALERT_CONDITIONS_TOO_MANY (即使有重复类型也先报数量)', () => {
      const five = [
        { type: 'PRICE_RISE_TO', threshold: 20 },
        { type: 'PRICE_FALL_TO', threshold: 13 },
        { type: 'DAILY_GAIN_OVER', threshold: 5 },
        { type: 'DAILY_LOSS_OVER', threshold: 7 },
        { type: 'PRICE_RISE_TO', threshold: 30 },
      ];
      expect(codes(draft({ conditions: five }))).toContain('ALERT_CONDITIONS_TOO_MANY');
    });
  });

  describe('同类型限 1 (FR-S02)', () => {
    it('同类型 2 条 → ALERT_CONDITION_TYPE_DUPLICATE', () => {
      expect(
        codes(
          draft({
            conditions: [
              { type: 'PRICE_FALL_TO', threshold: 13 },
              { type: 'PRICE_FALL_TO', threshold: 12 },
            ],
          }),
        ),
      ).toEqual(['ALERT_CONDITION_TYPE_DUPLICATE']);
    });
  });

  describe('条件类型词表', () => {
    // 023 演进：021 此例用 RSI_OVERSOLD 当未知串, 023 收编进词表 → 换真未知串
    it('未知类型 → ALERT_CONDITION_TYPE_UNKNOWN', () => {
      expect(codes(draft({ conditions: [{ type: 'PE_RATIO_BELOW', threshold: 30 }] }))).toEqual([
        'ALERT_CONDITION_TYPE_UNKNOWN',
      ]);
    });
  });

  describe('PRICE_* 阈值 > 0', () => {
    it.each([0, -1, NaN, Infinity])('threshold=%p → ALERT_PRICE_THRESHOLD_INVALID', (t) => {
      expect(codes(draft({ conditions: [{ type: 'PRICE_RISE_TO', threshold: t }] }))).toEqual([
        'ALERT_PRICE_THRESHOLD_INVALID',
      ]);
    });

    it('0.01 → 合法', () => {
      expect(codes(draft({ conditions: [{ type: 'PRICE_FALL_TO', threshold: 0.01 }] }))).toEqual(
        [],
      );
    });
  });

  describe('DAILY_* 阈值 ∈ (0,100]', () => {
    it.each([0, -5, 100.01, NaN])('threshold=%p → ALERT_PERCENT_THRESHOLD_INVALID', (t) => {
      expect(codes(draft({ conditions: [{ type: 'DAILY_LOSS_OVER', threshold: t }] }))).toEqual([
        'ALERT_PERCENT_THRESHOLD_INVALID',
      ]);
    });

    it.each([0.01, 7, 100])('threshold=%p → 合法', (t) => {
      expect(codes(draft({ conditions: [{ type: 'DAILY_GAIN_OVER', threshold: t }] }))).toEqual([]);
    });
  });

  describe('note ≤22 Unicode code point (D10)', () => {
    it('22 个汉字 → 合法', () => {
      expect(codes(draft({ note: '一'.repeat(22) }))).toEqual([]);
    });

    it('23 个汉字 → ALERT_NOTE_TOO_LONG', () => {
      expect(codes(draft({ note: '一'.repeat(23) }))).toEqual(['ALERT_NOTE_TOO_LONG']);
    });

    it('emoji (surrogate pair) 按 code point 计 1: 22 个 emoji 合法', () => {
      expect(noteCodePoints('😀'.repeat(22))).toBe(22);
      expect(codes(draft({ note: '😀'.repeat(22) }))).toEqual([]);
    });

    it('null / 缺省 note → 合法 (可空)', () => {
      expect(codes(draft({ note: null }))).toEqual([]);
      expect(codes(draft({ note: undefined }))).toEqual([]);
    });
  });

  describe('market 仅 cn (V1)', () => {
    it('hk → ALERT_MARKET_UNSUPPORTED', () => {
      expect(codes(draft({ market: 'hk' }))).toEqual(['ALERT_MARKET_UNSUPPORTED']);
    });
  });

  describe('frequency 枚举三档', () => {
    it.each(['ONCE_DELETE', 'ONCE_DISABLE', 'DAILY'])('%s → 合法', (f) => {
      expect(codes(draft({ frequency: f }))).toEqual([]);
    });

    it('未知档 → ALERT_FREQUENCY_UNKNOWN', () => {
      expect(codes(draft({ frequency: 'WEEKLY' }))).toEqual(['ALERT_FREQUENCY_UNKNOWN']);
    });
  });

  // ── 023 扩展：带参条件 + 新值域矩阵 (FR-S07) ────────────────────────────────
  describe('023 param 白名单 per type', () => {
    it.each([5, 10, 20, 60, 120, 250])('MA_CROSS_UP param=%p → 合法 (无 threshold)', (p) => {
      expect(codes(draft({ conditions: [{ type: 'MA_CROSS_UP', param: p }] }))).toEqual([]);
    });

    it.each([15, 0, -5, 2.5, undefined])('MA_CROSS_UP param=%p → ALERT_PARAM_INVALID', (p) => {
      expect(codes(draft({ conditions: [{ type: 'MA_CROSS_UP', param: p }] }))).toEqual([
        'ALERT_PARAM_INVALID',
      ]);
    });

    it('NEW_HIGH param=250 / PERIOD_GAIN_OVER param=5+阈值 / PE_PCTL_BELOW param=3+百分位 → 合法', () => {
      expect(
        codes(
          draft({
            conditions: [
              { type: 'NEW_HIGH', param: 250 },
              { type: 'PERIOD_GAIN_OVER', param: 5, threshold: 10 },
              { type: 'PE_PCTL_BELOW', param: 3, threshold: 20 },
            ],
          }),
        ),
      ).toEqual([]);
    });

    it('NEW_HIGH param=30 (出白名单) → ALERT_PARAM_INVALID', () => {
      expect(codes(draft({ conditions: [{ type: 'NEW_HIGH', param: 30 }] }))).toEqual([
        'ALERT_PARAM_INVALID',
      ]);
    });

    it('无参类型带 param → ALERT_PARAM_INVALID；param 0/缺省 → 合法 (sentinel)', () => {
      expect(codes(draft({ conditions: [{ type: 'PE_BELOW', param: 5, threshold: 10 }] }))).toEqual(
        ['ALERT_PARAM_INVALID'],
      );
      expect(codes(draft({ conditions: [{ type: 'PE_BELOW', param: 0, threshold: 10 }] }))).toEqual(
        [],
      );
      expect(codes(draft({ conditions: [{ type: 'PE_BELOW', threshold: 10 }] }))).toEqual([]);
    });
  });

  describe('023 threshold 值域 per 族', () => {
    it('positive 族 (PE/PB/量比/换手率): >0；换手率 >100 合法 (FR-S07 仅 ≤0 拒)', () => {
      expect(codes(draft({ conditions: [{ type: 'PE_BELOW', threshold: 0 }] }))).toEqual([
        'ALERT_POSITIVE_THRESHOLD_INVALID',
      ]);
      expect(codes(draft({ conditions: [{ type: 'VOLUME_RATIO_OVER', threshold: 2 }] }))).toEqual(
        [],
      );
      expect(
        codes(draft({ conditions: [{ type: 'TURNOVER_RATE_OVER', threshold: 150 }] })),
      ).toEqual([]);
      // 必带阈值: 缺省 → 同族错误码
      expect(codes(draft({ conditions: [{ type: 'PB_ABOVE' }] }))).toEqual([
        'ALERT_POSITIVE_THRESHOLD_INVALID',
      ]);
    });

    it('percent 族 (股息率/累计涨跌): ∈(0,100]', () => {
      expect(
        codes(draft({ conditions: [{ type: 'DIVIDEND_YIELD_ABOVE', threshold: 101 }] })),
      ).toEqual(['ALERT_PERCENT_THRESHOLD_INVALID']);
      expect(
        codes(draft({ conditions: [{ type: 'DIVIDEND_YIELD_ABOVE', threshold: 5 }] })),
      ).toEqual([]);
    });

    it.each([0, 100])('pctile 族闭区间: PE_PCTL_ABOVE threshold=%p → 合法', (t) => {
      expect(
        codes(draft({ conditions: [{ type: 'PE_PCTL_ABOVE', param: 5, threshold: t }] })),
      ).toEqual([]);
    });

    it.each([-1, 100.5])('pctile 出域 threshold=%p → ALERT_PCTL_THRESHOLD_INVALID', (t) => {
      expect(
        codes(draft({ conditions: [{ type: 'PB_PCTL_BELOW', param: 3, threshold: t }] })),
      ).toEqual(['ALERT_PCTL_THRESHOLD_INVALID']);
    });

    it.each([0, 100, 105, -5])('rsi 开区间出域 threshold=%p → ALERT_RSI_THRESHOLD_INVALID', (t) => {
      expect(codes(draft({ conditions: [{ type: 'RSI_OVERSOLD', threshold: t }] }))).toEqual([
        'ALERT_RSI_THRESHOLD_INVALID',
      ]);
    });

    it('RSI_OVERSOLD threshold=30 → 合法 (spec US 验收例)', () => {
      expect(codes(draft({ conditions: [{ type: 'RSI_OVERSOLD', threshold: 30 }] }))).toEqual([]);
    });

    it('无阈值类型带 threshold → ALERT_THRESHOLD_FORBIDDEN (none/ma/window kind)', () => {
      expect(codes(draft({ conditions: [{ type: 'MACD_GOLDEN_CROSS', threshold: 5 }] }))).toEqual([
        'ALERT_THRESHOLD_FORBIDDEN',
      ]);
      expect(
        codes(draft({ conditions: [{ type: 'MA_CROSS_UP', param: 20, threshold: 5 }] })),
      ).toEqual(['ALERT_THRESHOLD_FORBIDDEN']);
      expect(codes(draft({ conditions: [{ type: 'KDJ_OVERSOLD' }] }))).toEqual([]);
    });
  });

  describe('023 重复键 type → (type, param)', () => {
    it('同 type 不同 param 共存 (MA5 + MA20, FR-S07)', () => {
      expect(
        codes(
          draft({
            conditions: [
              { type: 'MA_CROSS_UP', param: 5 },
              { type: 'MA_CROSS_UP', param: 20 },
            ],
          }),
        ),
      ).toEqual([]);
    });

    it('同 type 同 param → ALERT_CONDITION_TYPE_DUPLICATE', () => {
      expect(
        codes(
          draft({
            conditions: [
              { type: 'MA_CROSS_UP', param: 20 },
              { type: 'MA_CROSS_UP', param: 20 },
            ],
          }),
        ),
      ).toEqual(['ALERT_CONDITION_TYPE_DUPLICATE']);
    });

    it('无参类型: param 缺省与 0 同键 → 重复', () => {
      expect(
        codes(
          draft({
            conditions: [
              { type: 'PE_BELOW', threshold: 10 },
              { type: 'PE_BELOW', param: 0, threshold: 8 },
            ],
          }),
        ),
      ).toEqual(['ALERT_CONDITION_TYPE_DUPLICATE']);
    });

    it('混类 4 条 (估值+穿越+量+技术) → 合法', () => {
      expect(
        codes(
          draft({
            conditions: [
              { type: 'PE_BELOW', threshold: 10 },
              { type: 'MA_CROSS_DOWN', param: 60 },
              { type: 'VOLUME_RATIO_OVER', threshold: 2 },
              { type: 'BOLL_BREAK_LOWER' },
            ],
          }),
        ),
      ).toEqual([]);
    });
  });

  // ── 024 扩展：盘中 5min 2 新 type 沿用 meta 驱动校验 (threshold percent / 无参) ─────
  describe('024 盘中 5min 涨跌超', () => {
    it.each(['PRICE_RISE_5MIN_OVER', 'PRICE_FALL_5MIN_OVER'])('%s ∈ 34 词表', (t) => {
      expect((ALERT_CONDITION_TYPES as readonly string[]).includes(t)).toBe(true);
    });

    it.each([0.01, 3, 5, 100])(
      'PRICE_RISE_5MIN_OVER threshold=%p → 合法 (percent (0,100])',
      (t) => {
        expect(
          codes(draft({ conditions: [{ type: 'PRICE_RISE_5MIN_OVER', threshold: t }] })),
        ).toEqual([]);
      },
    );

    it.each([0, -1, 100.01, NaN, Infinity])(
      'PRICE_FALL_5MIN_OVER threshold=%p → ALERT_PERCENT_THRESHOLD_INVALID',
      (t) => {
        expect(
          codes(draft({ conditions: [{ type: 'PRICE_FALL_5MIN_OVER', threshold: t }] })),
        ).toEqual(['ALERT_PERCENT_THRESHOLD_INVALID']);
      },
    );

    it('缺省 threshold → ALERT_PERCENT_THRESHOLD_INVALID (必带)', () => {
      expect(codes(draft({ conditions: [{ type: 'PRICE_RISE_5MIN_OVER' }] }))).toEqual([
        'ALERT_PERCENT_THRESHOLD_INVALID',
      ]);
    });

    it('带非 0 param → ALERT_PARAM_INVALID (无参类型，param 必 0/缺省)', () => {
      expect(
        codes(draft({ conditions: [{ type: 'PRICE_RISE_5MIN_OVER', param: 5, threshold: 3 }] })),
      ).toEqual(['ALERT_PARAM_INVALID']);
      expect(
        codes(draft({ conditions: [{ type: 'PRICE_RISE_5MIN_OVER', param: 0, threshold: 3 }] })),
      ).toEqual([]);
    });

    it('与到价类同 alert 共存 (PRICE_RISE_TO + PRICE_RISE_5MIN_OVER) → 合法', () => {
      expect(
        codes(
          draft({
            conditions: [
              { type: 'PRICE_RISE_TO', threshold: 20 },
              { type: 'PRICE_RISE_5MIN_OVER', threshold: 3 },
              { type: 'PRICE_FALL_5MIN_OVER', threshold: 5 },
            ],
          }),
        ),
      ).toEqual([]);
    });

    it('同 type 同参 (param 默认 0) → ALERT_CONDITION_TYPE_DUPLICATE', () => {
      expect(
        codes(
          draft({
            conditions: [
              { type: 'PRICE_RISE_5MIN_OVER', threshold: 3 },
              { type: 'PRICE_RISE_5MIN_OVER', threshold: 4 },
            ],
          }),
        ),
      ).toEqual(['ALERT_CONDITION_TYPE_DUPLICATE']);
    });
  });

  it('多处违规 → 错误并列 (UC 一次性喂 400 detail)', () => {
    const result = codes(
      draft({
        market: 'us',
        frequency: 'WEEKLY',
        note: '一'.repeat(23),
        conditions: [
          { type: 'PRICE_FALL_TO', threshold: 0 },
          { type: 'DAILY_GAIN_OVER', threshold: 101 },
        ],
      }),
    );
    expect(result).toEqual(
      expect.arrayContaining([
        'ALERT_MARKET_UNSUPPORTED',
        'ALERT_FREQUENCY_UNKNOWN',
        'ALERT_NOTE_TOO_LONG',
        'ALERT_PRICE_THRESHOLD_INVALID',
        'ALERT_PERCENT_THRESHOLD_INVALID',
      ]),
    );
  });
});
