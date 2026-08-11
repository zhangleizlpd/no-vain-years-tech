import { describe, expect, it } from 'vitest';
import * as legMark from './leg-mark.rules';
import { BUILD_RECOMMEND_ABS_DELTA_BAND, RENT_RECOMMEND_ABS_DELTA_BANDS } from './leg-mark.rules';

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
