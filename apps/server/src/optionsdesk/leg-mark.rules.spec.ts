import { describe, expect, it } from 'vitest';
import type { LegIntent, RentDepth } from './intent-matrix.rules';
import * as legMark from './leg-mark.rules';
import {
  BUILD_RECOMMEND_ABS_DELTA_BAND,
  MONTHLY_EXPIRY_LOOKBACK_DAYS,
  RENT_RECOMMEND_ABS_DELTA_BANDS,
  isRecommended,
  monthlyExpiryCandidates,
  resolveMonthlyExpiries,
  thirdFridayOf,
} from './leg-mark.rules';

describe('leg-mark.rules — Δ 带自召回层迁入打标层, 值不变 (plan D-MARK-1)', () => {
  it('建仓推荐带 = 047 `BUILD_LEG_ABS_DELTA_BAND` 原值', () => {
    expect(BUILD_RECOMMEND_ABS_DELTA_BAND).toEqual({ min: 0.4, max: 0.55 });
  });

  it('收租三档推荐带 = 047 `RENT_DEPTH_ABS_DELTA_BANDS` 原值, 键序由浅到深', () => {
    expect(RENT_RECOMMEND_ABS_DELTA_BANDS).toEqual({
      near_atm: { min: 0.3, max: 0.4 },
      moderate: { min: 0.15, max: 0.3 },
      deep: { min: 0.05, max: 0.15 },
    });
  });

  it('🚨 三档并集整条不迁不留 —— 它是**召回**语义的产物 (Guardrail 1)', () => {
    // 「不替人做方向性假设」这条原则在召回语义下导出「取并集放宽收进来」、在打标语义下导出
    // 「不打标」。并集常量一旦跟着搬过来, 就是那个坑的入口 —— 照抄它会让「水位未选」时全表
    // 冒出一片推荐标, 而代码看着完全合理。⇒ 结构上不给它存在的机会。
    expect(Object.keys(legMark)).not.toContain('RENT_DEPTH_UNION_BAND');
  });
});

/**
 * T006 —— 推荐标真值表 (FR-011 / FR-012 / FR-013)。
 *
 * 两个探针**互不落入对方的带**, 所以「取错了带」这种错法抓得到, 而不是碰巧两边都为真:
 * `0.45` 只落建仓带 `[0.40,0.55]`, `0.35` 只落 `near_atm` 带 `[0.30,0.40]`。
 */
describe('leg-mark.rules — isRecommended 完整真值表 (FR-011/FR-012/FR-013)', () => {
  const IN_BUILD = 0.45;
  const IN_NEAR_ATM = 0.35;

  /** 4 种 intent × (未选 + 三档水位) 全枚举; `expected` = [探针 0.45, 探针 0.35] 的期望。 */
  const TRUTH_TABLE: ReadonlyArray<{
    intent: LegIntent;
    rentDepth: RentDepth | null;
    expected: [boolean, boolean];
  }> = [
    // 建仓意图取建仓带, 且**不看** rentDepth —— 该态下矩阵恒给 null, 但函数不能依赖调用方守约。
    { intent: 'build_position', rentDepth: null, expected: [true, false] },
    { intent: 'build_position', rentDepth: 'near_atm', expected: [true, false] },
    { intent: 'build_position', rentDepth: 'moderate', expected: [true, false] },
    { intent: 'build_position', rentDepth: 'deep', expected: [true, false] },
    // 🚨 收租 + 水位未选恒 false (Guardrail 1) —— 见下方那条单独的守卫用例。
    { intent: 'rent', rentDepth: null, expected: [false, false] },
    { intent: 'rent', rentDepth: 'near_atm', expected: [false, true] },
    { intent: 'rent', rentDepth: 'moderate', expected: [false, false] },
    { intent: 'rent', rentDepth: 'deep', expected: [false, false] },
    // 待定 / 不开新仓: 没有方向就没有标 (FR-012), 与水位档和 Δ 都无关。
    { intent: 'pending', rentDepth: null, expected: [false, false] },
    { intent: 'pending', rentDepth: 'near_atm', expected: [false, false] },
    { intent: 'pending', rentDepth: 'moderate', expected: [false, false] },
    { intent: 'pending', rentDepth: 'deep', expected: [false, false] },
    { intent: 'no_new_position', rentDepth: null, expected: [false, false] },
    { intent: 'no_new_position', rentDepth: 'near_atm', expected: [false, false] },
    { intent: 'no_new_position', rentDepth: 'moderate', expected: [false, false] },
    { intent: 'no_new_position', rentDepth: 'deep', expected: [false, false] },
  ];

  it('16 格真值表逐格相符 (4 种 intent × 未选 + 三档水位)', () => {
    for (const { intent, rentDepth, expected } of TRUTH_TABLE) {
      const at = `${intent} × ${rentDepth ?? '水位未选'}`;
      expect([at, isRecommended(intent, rentDepth, IN_BUILD)]).toEqual([at, expected[0]]);
      expect([at, isRecommended(intent, rentDepth, IN_NEAR_ATM)]).toEqual([at, expected[1]]);
    }
  });

  it('🚨 收租 + 水位未选 → **恒** false, 三档带的任何取值都打不出标 (Guardrail 1 的守卫)', () => {
    // 「不替人做方向性假设」在**召回**语义下导出「取三档并集放宽收进来」, 在**打标**语义下导出
    // 「不打标」。照抄召回那半边会让水位未选时全表冒出一片推荐标, 而那段代码看着完全合理。
    // ⇒ 这里把三档带的**全部端点**都过一遍: 只要实现里出现任何形式的并集, 本条立刻红。
    for (const band of Object.values(RENT_RECOMMEND_ABS_DELTA_BANDS)) {
      for (const absDelta of [band.min, band.max, (band.min + band.max) / 2]) {
        expect(isRecommended('rent', null, absDelta)).toBe(false);
      }
    }
  });

  it('absDelta 为 null → 恒 false (FR-013: 缺 Δ 不能推定落在任何带内)', () => {
    for (const { intent, rentDepth } of TRUTH_TABLE) {
      expect(isRecommended(intent, rentDepth, null)).toBe(false);
    }
  });

  it('建仓带**两端均可取到**, 带外一点点即不打', () => {
    const { min, max } = BUILD_RECOMMEND_ABS_DELTA_BAND;
    expect(isRecommended('build_position', null, min)).toBe(true); // 恰好 0.40
    expect(isRecommended('build_position', null, max)).toBe(true); // 恰好 0.55
    expect(isRecommended('build_position', null, 0.3999)).toBe(false);
    expect(isRecommended('build_position', null, 0.5501)).toBe(false);
  });

  it('收租三档各自的两端均可取到; 相邻两档共享的端点在各自档下都成立', () => {
    for (const [depth, band] of Object.entries(RENT_RECOMMEND_ABS_DELTA_BANDS)) {
      expect(isRecommended('rent', depth as RentDepth, band.min)).toBe(true);
      expect(isRecommended('rent', depth as RentDepth, band.max)).toBe(true);
    }
    // 0.30 是 moderate 的上端也是 near_atm 的下端 —— 两档各自都收它, 这不是重叠 bug:
    // 档由**水位**定, 同一时刻只会取其中一档去判。
    expect(isRecommended('rent', 'moderate', 0.3)).toBe(true);
    expect(isRecommended('rent', 'near_atm', 0.3)).toBe(true);
    // 带外: deep 的下端之下 / near_atm 的上端之上。
    expect(isRecommended('rent', 'deep', 0.0499)).toBe(false);
    expect(isRecommended('rent', 'near_atm', 0.4001)).toBe(false);
  });
});

/**
 * T007 —— 月度链标的两个纯函数 (FR-014 / FR-015, plan D-MARK-2)。
 *
 * 🚨 期望值是**独立于实现算出来的日历事实**, 不是拿同一套 `Date` 运算再算一遍 —— 后者是
 * 同义反复。锚点: 2026-01-01 是周四; 2027-01-15 与 2026-08-21 分别是那两个月的公认月度
 * opex 日 (与 047 IT 里当 `RENT_EXPIRY` 用的那个日期对得上)。
 */
describe('leg-mark.rules — thirdFridayOf: 该月第三个周五 (FR-015)', () => {
  it('逐月对照真日历 (含 1 月 / 12 月 / 跨年)', () => {
    // 2026-01-01 周四 ⇒ 周五落 2 / 9 / 16。
    expect(thirdFridayOf(2026, 1)).toBe('2026-01-16');
    // 2026-02-01 周日 ⇒ 6 / 13 / 20。
    expect(thirdFridayOf(2026, 2)).toBe('2026-02-20');
    // 2026-09-01 周二 ⇒ 4 / 11 / 18。
    expect(thirdFridayOf(2026, 9)).toBe('2026-09-18');
    // 12 月 → 次年 1 月: 月份进位由调用方给 (year, month), 本函数不做跨年推算, 但两侧都要对。
    expect(thirdFridayOf(2026, 12)).toBe('2026-12-18');
    expect(thirdFridayOf(2027, 1)).toBe('2027-01-15');
  });

  it('两个极端: 1 号就是周五 (最早, 15 号) / 1 号是周六 (最晚, 21 号)', () => {
    // 2026-05-01 周五 ⇒ 1 / 8 / 15 —— 第三个周五落在**上半月**。
    expect(thirdFridayOf(2026, 5)).toBe('2026-05-15');
    // 2026-08-01 周六 ⇒ 7 / 14 / 21 —— 21 号是第三个周五**可能取到的最大日**。
    expect(thirdFridayOf(2026, 8)).toBe('2026-08-21');
  });

  it('输出恒为零填充的 `YYYY-MM-DD`, 月 / 日各两位', () => {
    expect(thirdFridayOf(2026, 1)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(thirdFridayOf(2026, 5)).toMatch(/^2026-05-\d{2}$/);
  });
});

describe('leg-mark.rules — monthlyExpiryCandidates: 链上到期日 → 候选月度日 (plan D-MARK-2)', () => {
  it('按 (年, 月) 去重后每月一个候选日, 升序', () => {
    expect(
      monthlyExpiryCandidates([
        '2026-08-14',
        '2026-08-21', // 与上一条同月 ⇒ 只出一个候选
        '2027-01-15',
        '2026-09-04',
      ]),
    ).toEqual(['2026-08-21', '2026-09-18', '2027-01-15']);
  });

  it('空链 → 空候选集 (调用方据此跳过整次日历查询)', () => {
    expect(monthlyExpiryCandidates([])).toEqual([]);
  });
});

describe('leg-mark.rules — resolveMonthlyExpiries: 假日回退取前一交易日 (FR-015)', () => {
  it('候选日本身是交易日 → 取它自己', () => {
    const days = ['2026-09-17', '2026-09-18', '2026-09-21'];
    expect(resolveMonthlyExpiries(['2026-09-18'], days)).toEqual(new Set(['2026-09-18']));
  });

  it('🚨 候选日非交易日 → 取 ≤ 它的**最大**交易日 (判据取自日历, 不是「是不是周五」)', () => {
    // 构造: 第三个周五 09-18 停市 (纪念日), 前一交易日是 09-17。
    const days = ['2026-09-16', '2026-09-17', '2026-09-21'];
    expect(resolveMonthlyExpiries(['2026-09-18'], days)).toEqual(new Set(['2026-09-17']));
  });

  it('多个候选日各自独立回退, 结果是集合 (同一月只可能贡献一个)', () => {
    const days = ['2026-08-20', '2026-08-24', '2027-01-15'];
    // 08-21 停市 → 回退 08-20; 2027-01-15 是交易日 → 取自己。
    expect(resolveMonthlyExpiries(['2026-08-21', '2027-01-15'], days)).toEqual(
      new Set(['2026-08-20', '2027-01-15']),
    );
  });

  it('交易日集为空 → 空集合, **不炸** (日历未填充该区间是事实, 不是故障)', () => {
    expect(resolveMonthlyExpiries(['2026-09-18'], [])).toEqual(new Set());
  });

  it('入参交易日乱序照样正确 (内部自己排, 不依赖调用方的 orderBy)', () => {
    const days = ['2026-09-21', '2026-09-16', '2026-09-17'];
    expect(resolveMonthlyExpiries(['2026-09-18'], days)).toEqual(new Set(['2026-09-17']));
  });

  it(`🚨 回退距离超过 ${MONTHLY_EXPIRY_LOOKBACK_DAYS} 天 → **一个都不标**, 而不是标到一个远日子`, () => {
    // 美股连续休市 (含周末) 从不超过 4 个日历日 ⇒ 回退超过一周只可能是**日历数据缺了一段**。
    // 此时标出来的日期看着完全正常, 却是错的 —— 与 clarify 否决「从链自身分布反推」同一条理由:
    // 宁可不标, 不可标错。
    const days = ['2026-08-01', '2026-08-02'];
    expect(resolveMonthlyExpiries(['2026-09-18'], days)).toEqual(new Set());
    // 边界: 恰好 7 天仍取 (含端点), 8 天不取。
    expect(resolveMonthlyExpiries(['2026-09-18'], ['2026-09-11'])).toEqual(new Set(['2026-09-11']));
    expect(resolveMonthlyExpiries(['2026-09-18'], ['2026-09-10'])).toEqual(new Set());
  });

  it('候选日之前一个交易日都没有 → 跳过它, 不炸也不编日期', () => {
    expect(resolveMonthlyExpiries(['2026-09-18'], ['2026-09-21', '2026-09-22'])).toEqual(new Set());
  });
});
