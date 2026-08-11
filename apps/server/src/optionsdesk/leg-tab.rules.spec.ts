import { describe, expect, it } from 'vitest';
import { RENT_SHORT_MAX_DTE_DAYS, earningsLegFamilyFor } from './leg-tab.rules';

/**
 * 📌 050 瘦身后本文件只剩财报域划分。删掉的五条用例逐条有归宿, **不是覆盖流失**:
 *
 * | 047 用例 | 去向 |
 * | --- | --- |
 * | 全腿 Tab 恒含每一条腿 | `leg-recall.rules.spec.ts`「全腿 Tab 恒在返回里」 |
 * | 建仓带两端闭合 + DTE 超界 | `leg-recall.rules.spec.ts`「建仓段四个端点闭合」(判据已换代) |
 * | 卖put区走锚轴 / 买区走市场轴 | **随锚轴判据整条退役** —— 收租召回不再看 Δ 与 K ≤ W |
 * | 收租 DTE 带两端闭合 | `leg-recall.rules.spec.ts`「收租段四个端点闭合」 |
 * | 水位未选取三档并集 | **随并集常量整条退役**; 打标层的对应用例是「未选恒不打标」(T006) |
 */
describe('leg-tab.rules — 财报打标的域 (FR-023, 050 一行不改)', () => {
  it('建仓意图恒建仓域 (与 DTE 无关); 其余按 DTE 分长短', () => {
    expect(earningsLegFamilyFor('build_position', 300)).toBe('build_position');
    expect(earningsLegFamilyFor('rent', RENT_SHORT_MAX_DTE_DAYS)).toBe('rent_short');
    expect(earningsLegFamilyFor('rent', RENT_SHORT_MAX_DTE_DAYS + 1)).toBe('rent_long');
  });

  it('待定与不开新仓都不是建仓授权 ⇒ 按收租域打标 (腿数据照常全量展示, FR-021)', () => {
    expect(earningsLegFamilyFor('pending', 200)).toBe('rent_long');
    expect(earningsLegFamilyFor('no_new_position', 10)).toBe('rent_short');
  });
});
