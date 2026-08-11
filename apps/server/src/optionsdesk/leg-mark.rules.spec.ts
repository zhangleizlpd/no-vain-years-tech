import { describe, expect, it } from 'vitest';
import type { LegIntent, RentDepth } from './intent-matrix.rules';
import * as legMark from './leg-mark.rules';
import {
  BUILD_RECOMMEND_ABS_DELTA_BAND,
  RENT_RECOMMEND_ABS_DELTA_BANDS,
  isRecommended,
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
