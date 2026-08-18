import { describe, expect, it } from 'vitest';
import { advanceCoverage } from './calendar-coverage.rules.js';

/** 既有声明: 2026-08-01..2026-08-31 (整月)。 */
const CURRENT = { from: '2026-08-01', to: '2026-08-31' } as const;

describe('advanceCoverage — 覆盖声明推进判据 (062 T002, FR-001/FR-002/FR-003, state_branches 10-11)', () => {
  describe('首次 (current === null) → 直接采用 filled', () => {
    it('无既有声明 → 整段成为新声明', () => {
      const r = advanceCoverage(null, { from: '2026-08-01', to: '2026-12-31' });
      expect(r).toEqual({ advanced: true, coverage: { from: '2026-08-01', to: '2026-12-31' } });
    });
  });

  describe('相邻 / 重叠 → 扩展', () => {
    it('右相邻 (filled.from === current.to + 1 天) → 推进终点', () => {
      const r = advanceCoverage(CURRENT, { from: '2026-09-01', to: '2026-12-31' });
      expect(r).toEqual({ advanced: true, coverage: { from: '2026-08-01', to: '2026-12-31' } });
    });

    it('重叠 → 并集, 不因重叠而拒绝', () => {
      const r = advanceCoverage(CURRENT, { from: '2026-08-20', to: '2026-12-31' });
      expect(r).toEqual({ advanced: true, coverage: { from: '2026-08-01', to: '2026-12-31' } });
    });

    it('🚨 向前扩: covered_to 取 max —— filled 整段被 current 包含时终点 MUST NOT 缩回去', () => {
      const r = advanceCoverage(
        { from: '2026-08-01', to: '2026-12-31' },
        { from: '2026-08-10', to: '2026-08-20' },
      );
      expect(r).toEqual({ advanced: true, coverage: { from: '2026-08-01', to: '2026-12-31' } });
    });

    /**
     * 🚨 单独断言的理由: `covered_from` 取 min / `covered_to` 取 max **写反了不会红** ——
     * 上面几条右扩用例在 min/max 互换后照样过 (它们的 from 恒等于 current.from)。只有一条
     * 「左相邻」用例能把方向钉住。
     */
    it('🚨 向后扩 (左相邻): covered_from 取 min, 终点不动', () => {
      const r = advanceCoverage(CURRENT, { from: '2026-07-01', to: '2026-07-31' });
      expect(r).toEqual({ advanced: true, coverage: { from: '2026-07-01', to: '2026-08-31' } });
    });

    it('跨月跨闰: 2月末左相邻 (2026-02-28 → 03-01)', () => {
      const r = advanceCoverage(
        { from: '2026-03-01', to: '2026-03-31' },
        { from: '2026-02-01', to: '2026-02-28' },
      );
      expect(r).toEqual({ advanced: true, coverage: { from: '2026-02-01', to: '2026-03-31' } });
    });
  });

  describe('🚨 有缺口 → 不推进 + 显式原因 (MUST NOT 静默返回 current)', () => {
    it('右侧缺口 (filled.from 比 current.to + 1 还晚) → advanced: false + 原因', () => {
      const r = advanceCoverage(CURRENT, { from: '2026-09-10', to: '2026-12-31' });
      expect(r.advanced).toBe(false);
      expect(r).not.toHaveProperty('coverage');
      if (r.advanced) throw new Error('unreachable');
      expect(r.reason).toContain('2026-09-10');
      expect(r.reason).toContain('2026-08-31');
    });

    /**
     * 🚨 **写单边判据 (`filled.from <= current.to + 1`) 时这条必红。** 单边判据对左侧缺口
     * 恒为真 ⇒ 会把 2020 年那段与今年的声明合并成一条横跨六年的承诺, 中间几年从没填过 ——
     * 「库里没有的即为假」原样重演在声明层。
     */
    it('🚨 左侧缺口 (filled.to 比 current.from - 1 还早) → advanced: false, MUST NOT 合并出空洞', () => {
      const r = advanceCoverage(CURRENT, { from: '2020-01-01', to: '2020-12-31' });
      expect(r.advanced).toBe(false);
    });

    it('缺口只差一天也不推进 (相邻的判据是闭合的, 不留模糊带)', () => {
      const r = advanceCoverage(CURRENT, { from: '2026-09-02', to: '2026-12-31' });
      expect(r.advanced).toBe(false);
    });
  });

  describe('非法输入 → throw (字典序比较 + 日期加减的前置条件)', () => {
    it.each([
      ['filled.from 斜杠', { from: '2026/09/01', to: '2026-12-31' }],
      ['filled.to 缺前导零', { from: '2026-09-01', to: '2026-12-1' }],
    ])('%s → throw', (_l, filled) => {
      expect(() => advanceCoverage(CURRENT, filled)).toThrow(/非法日期/);
    });

    it('current 脏 → 同样 throw (声明本身脏时不许静默参与比较)', () => {
      expect(() =>
        advanceCoverage(
          { from: '2026-08-01', to: '20260831' },
          { from: '2026-09-01', to: '2026-12-31' },
        ),
      ).toThrow(/非法日期/);
    });

    it.each([
      ['filled 区间反向', CURRENT, { from: '2026-12-31', to: '2026-09-01' }],
      [
        'current 区间反向',
        { from: '2026-08-31', to: '2026-08-01' },
        { from: '2026-09-01', to: '2026-12-31' },
      ],
    ])('%s → throw (min/max 会静默把它「修正」成一段没填过的承诺)', (_l, current, filled) => {
      expect(() => advanceCoverage(current, filled)).toThrow(/区间非法/);
    });
  });
});
