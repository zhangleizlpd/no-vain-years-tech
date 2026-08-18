import { describe, expect, it } from 'vitest';
import { classifyTradingDay } from './trading-day.rules.js';

/** 默认覆盖声明: 2026-08-01..2026-08-31 (整月, 边界断言全落在这两端上)。 */
const COVERAGE = { from: '2026-08-01', to: '2026-08-31' } as const;

describe('classifyTradingDay — 交易日三态判据 (062 T001, FR-010/FR-011, state_branches 1-4)', () => {
  describe('state_branch 1 — 有记录 → trading', () => {
    it('该日在库有行 → trading', () => {
      expect(
        classifyTradingDay({ hasExactRow: true, coverage: COVERAGE, date: '2026-08-14' }),
      ).toBe('trading');
    });

    it('有记录时覆盖声明缺席/区间外都不改变答案 (记录本身即事实)', () => {
      expect(classifyTradingDay({ hasExactRow: true, coverage: null, date: '2026-08-14' })).toBe(
        'trading',
      );
      expect(
        classifyTradingDay({ hasExactRow: true, coverage: COVERAGE, date: '2026-12-31' }),
      ).toBe('trading');
    });
  });

  describe('state_branch 2 — 无记录 + 落在覆盖区间内 → non-trading', () => {
    it('区间内无行 = 该日真非交易日', () => {
      expect(
        classifyTradingDay({ hasExactRow: false, coverage: COVERAGE, date: '2026-08-15' }),
      ).toBe('non-trading');
    });

    it('边界: date 恰等于 covered_from → 仍在区间内 (闭区间)', () => {
      expect(
        classifyTradingDay({ hasExactRow: false, coverage: COVERAGE, date: COVERAGE.from }),
      ).toBe('non-trading');
    });

    it('边界: date 恰等于 covered_to → 仍在区间内 (闭区间)', () => {
      expect(
        classifyTradingDay({ hasExactRow: false, coverage: COVERAGE, date: COVERAGE.to }),
      ).toBe('non-trading');
    });
  });

  describe('state_branch 3 — 无记录 + 落在覆盖区间外 → unknown', () => {
    it('边界: covered_to 后一天 (跨月) → unknown, MUST NOT 是 non-trading', () => {
      const status = classifyTradingDay({
        hasExactRow: false,
        coverage: COVERAGE,
        date: '2026-09-01',
      });
      expect(status).toBe('unknown');
      expect(status).not.toBe('non-trading');
    });

    it('covered_from 之前一天 → unknown (左端同样是「还没填过」)', () => {
      expect(
        classifyTradingDay({ hasExactRow: false, coverage: COVERAGE, date: '2026-07-31' }),
      ).toBe('unknown');
    });
  });

  describe('state_branch 4 — 无覆盖声明 → unknown', () => {
    /**
     * 🚨 **本 feature 要根治的病的同源形状。** 「没有声明」= 从没人承诺过填到哪儿, 把它读成
     * non-trading 就是把「库里没有的即为假」换个地方原样犯一遍 (首次上线 / 声明被清空时全市场
     * 静默停摆)。故此处不只断言等于 unknown, 还**显式断言不等于 non-trading**。
     */
    it.each([
      ['远古', '1970-01-01'],
      ['今年年初', '2026-01-01'],
      ['今天', '2026-08-18'],
      ['远未来', '2099-12-31'],
    ])(
      'coverage === null 时任何无记录日期 (%s) → unknown 且 MUST NOT 是 non-trading',
      (_l, date) => {
        const status = classifyTradingDay({ hasExactRow: false, coverage: null, date });
        expect(status).toBe('unknown');
        expect(status).not.toBe('non-trading');
      },
    );
  });

  describe('非法日期格式 → throw (字典序比较的前置条件)', () => {
    it.each([
      ['斜杠分隔', '2026/03/01'],
      ['缺前导零', '2026-3-1'],
      ['带时间', '2026-03-01T00:00:00Z'],
      ['空串', ''],
    ])('date 非 YYYY-MM-DD (%s) → throw', (_l, date) => {
      expect(() => classifyTradingDay({ hasExactRow: false, coverage: COVERAGE, date })).toThrow(
        /非法日期/,
      );
    });

    it('coverage.from / coverage.to 非 YYYY-MM-DD → throw (声明本身脏也不许静默比较)', () => {
      expect(() =>
        classifyTradingDay({
          hasExactRow: false,
          coverage: { from: '2026/08/01', to: '2026-08-31' },
          date: '2026-08-15',
        }),
      ).toThrow(/非法日期/);
      expect(() =>
        classifyTradingDay({
          hasExactRow: false,
          coverage: { from: '2026-08-01', to: '20260831' },
          date: '2026-08-15',
        }),
      ).toThrow(/非法日期/);
    });

    it('有记录时同样先校验格式 (脏输入不因短路而漏网)', () => {
      expect(() =>
        classifyTradingDay({ hasExactRow: true, coverage: null, date: '2026/08/14' }),
      ).toThrow(/非法日期/);
    });
  });
});
