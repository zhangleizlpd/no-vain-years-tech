import { describe, it, expect } from 'vitest';
import { Prisma } from '../generated/prisma/client';
import {
  ANCHOR_MANUAL_COLUMN_BY_SLOT,
  ANCHOR_MANUAL_SLOTS,
  buildImportFallbackReport,
  buildModelImportPatch,
  cascadeOnManualConfidenceChange,
  cascadeOnManualLLevelChange,
  cascadeOnModelImport,
  cascadeOnUndoManualSlot,
  resolveEffectiveAnchorValues,
  type AnchorManualState,
} from './anchor-cascade';

const D = (v: string): Prisma.Decimal => new Prisma.Decimal(v);

function manualState(overrides: Partial<AnchorManualState> = {}): AnchorManualState {
  return { vManual: null, lLevelManual: null, positionCapManual: null, ...overrides };
}

/** 三处人工位全满 (V / L 层 / 单票上限)。 */
const allManual = manualState({
  vManual: D('55'),
  lLevelManual: 'L3',
  positionCapManual: D('0.10'),
});

// ─────────────────────────────────────────────────────────────────────────────
// 路径 ① 模型批量 import → 冲掉三处人工值 (FR-035 ①)
// ─────────────────────────────────────────────────────────────────────────────
describe('anchor-cascade — 路径 ① 模型 import 回落三处人工值', () => {
  it('三处人工态全部被清空', () => {
    const outcome = cascadeOnModelImport(allManual);
    expect(outcome.manualStateAfter).toEqual(manualState());
  });

  it('clearedSlots 逐条列出被回落项 (差异报告的数据基础, 禁静默回落)', () => {
    const outcome = cascadeOnModelImport(allManual);
    expect([...outcome.clearedSlots].sort()).toEqual([...ANCHOR_MANUAL_SLOTS].sort());
  });

  it('无人工态的锚 → 零 clearedSlots、零 changedFields (不产生噪声条目)', () => {
    const outcome = cascadeOnModelImport(manualState());
    expect(outcome.clearedSlots).toEqual([]);
    expect(outcome.changedFields).toEqual([]);
  });

  it('changedFields 用 schema 列名 (供 FR-031 痕迹)', () => {
    const outcome = cascadeOnModelImport(manualState({ lLevelManual: 'L3' }));
    expect(outcome.changedFields).toEqual([ANCHOR_MANUAL_COLUMN_BY_SLOT.lLevel]);
  });
});

describe('anchor-cascade — 模型 import 写侧 patch (Guardrail 11)', () => {
  const patch = buildModelImportPatch({ v: '60', confidence: '9.2' });

  it('confidence_source 翻 model ⇒ 该锚自动转只读, 无需人工干预 (FR-001)', () => {
    expect(patch.confidenceSource).toBe('model');
  });

  it('三处人工位一并置 null (临时语义, 不存在锁定)', () => {
    expect(patch.vManual).toBeNull();
    expect(patch.lLevelManual).toBeNull();
    expect(patch.positionCapManual).toBeNull();
  });

  it('生效 L 层随新 confidence 写入时求值', () => {
    expect(patch.lLevelEffective).toBe('L1');
  });

  it('🚨 MUST NOT 重置 next_review / 解除逾期红标 —— patch 里没有这些键', () => {
    const keys = Object.keys(patch);
    expect(keys).not.toContain('nextReview');
    expect(keys).not.toContain('lastReviewedOn');
  });

  it('MUST NOT 碰复核锚状态机载体 breach_started_on', () => {
    expect(Object.keys(patch)).not.toContain('breachStartedOn');
  });
});

describe('anchor-cascade — import 差异报告数据结构 (FR-035 ①)', () => {
  const report = buildImportFallbackReport([
    { ticker: 'us:AOS', manual: allManual, next: { v: '60', confidence: '9.2' } },
    { ticker: 'us:PEP', manual: manualState(), next: { v: '150', confidence: '5' } },
    {
      ticker: 'us:TAP',
      manual: manualState({ positionCapManual: D('0.30') }),
      next: { v: '40', confidence: '1' },
    },
  ]);

  it('逐条列出被回落项 (三处人工的锚出 3 条, 无人工的锚出 0 条)', () => {
    expect(report.filter((e) => e.ticker === 'us:AOS')).toHaveLength(3);
    expect(report.filter((e) => e.ticker === 'us:PEP')).toHaveLength(0);
  });

  it('每条带人工值与回落后的值 (使人能据报告回 App 重新调整)', () => {
    const entry = report.find((e) => e.ticker === 'us:AOS' && e.slot === 'lLevel');
    expect(entry).toMatchObject({ manualValue: 'L3', fallbackValue: 'L1' });
  });

  it('V 人工值回落到模型新 V', () => {
    const entry = report.find((e) => e.ticker === 'us:AOS' && e.slot === 'v');
    expect(entry).toMatchObject({ manualValue: '55', fallbackValue: '60' });
  });

  it('L4 无上限口径 ⇒ 上限回落值为 null, 不自造数值 (FR-030)', () => {
    const entry = report.find((e) => e.ticker === 'us:TAP' && e.slot === 'positionCap');
    expect(entry).toMatchObject({ manualValue: '0.3', fallbackValue: null });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 路径 ② 人工改 L 层 → 冲掉单票上限人工值 (FR-035 ② / EC-6)
// ─────────────────────────────────────────────────────────────────────────────
describe('anchor-cascade — 路径 ② 人工改 L 层', () => {
  it('EC-6 单票上限人工态 ∧ 上游 L 层被改 → 上限回落 (临时语义下上游赢)', () => {
    const outcome = cascadeOnManualLLevelChange(
      manualState({ lLevelManual: 'L2', positionCapManual: D('0.10') }),
    );
    expect(outcome.manualStateAfter.positionCapManual).toBeNull();
    expect(outcome.clearedSlots).toEqual(['positionCap']);
  });

  it('只冲下游: V 人工值不受牵连 (V 不在两级链上)', () => {
    const outcome = cascadeOnManualLLevelChange(allManual);
    expect(outcome.manualStateAfter.vManual).toEqual(D('55'));
  });

  it('L 层自身的人工态不被本路径清掉 (改的就是它)', () => {
    const outcome = cascadeOnManualLLevelChange(manualState({ lLevelManual: 'L2' }));
    expect(outcome.manualStateAfter.lLevelManual).toBe('L2');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 路径 ③ 手工锚改 confidence → 沿两级链冲掉 L 层与单票上限 (FR-035 ③ / EC-9)
// ─────────────────────────────────────────────────────────────────────────────
describe('anchor-cascade — 路径 ③ 手工锚改 confidence', () => {
  it('EC-9 L 层人工态 → L 层与单票上限两处一并回落', () => {
    const outcome = cascadeOnManualConfidenceChange(
      manualState({ lLevelManual: 'L3', positionCapManual: D('0.10') }),
    );
    expect(outcome.manualStateAfter.lLevelManual).toBeNull();
    expect(outcome.manualStateAfter.positionCapManual).toBeNull();
  });

  it('两处同时人工态 → 一次 outcome 同时给出, 无「只回落其中一处」的中间态', () => {
    const outcome = cascadeOnManualConfidenceChange(
      manualState({ lLevelManual: 'L3', positionCapManual: D('0.10') }),
    );
    expect([...outcome.clearedSlots].sort()).toEqual(['lLevel', 'positionCap']);
    expect(outcome.changedFields).toHaveLength(2);
  });

  it('V 人工值不在 confidence 链上 → 不被冲掉', () => {
    const outcome = cascadeOnManualConfidenceChange(allManual);
    expect(outcome.manualStateAfter.vManual).toEqual(D('55'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 撤销任一层 → 立即回落 + 下游随之 (FR-032 ③ / FR-035)
// ─────────────────────────────────────────────────────────────────────────────
describe('anchor-cascade — 撤销人工位', () => {
  it('撤销 L 层 → 自身回落且下游单票上限随之回落', () => {
    const outcome = cascadeOnUndoManualSlot(
      manualState({ lLevelManual: 'L3', positionCapManual: D('0.10') }),
      'lLevel',
    );
    expect(outcome.manualStateAfter.lLevelManual).toBeNull();
    expect(outcome.manualStateAfter.positionCapManual).toBeNull();
    expect([...outcome.clearedSlots].sort()).toEqual(['lLevel', 'positionCap']);
  });

  it('撤销单票上限 → 只回落自身 (它是链尾, 无下游)', () => {
    const outcome = cascadeOnUndoManualSlot(allManual, 'positionCap');
    expect(outcome.clearedSlots).toEqual(['positionCap']);
    expect(outcome.manualStateAfter.lLevelManual).toBe('L3');
  });

  it('撤销 V → 只回落自身 (V 与两级链无上下游关系)', () => {
    const outcome = cascadeOnUndoManualSlot(allManual, 'v');
    expect(outcome.clearedSlots).toEqual(['v']);
    expect(outcome.manualStateAfter.lLevelManual).toBe('L3');
    expect(outcome.manualStateAfter.positionCapManual).toEqual(D('0.10'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 生效值解算 —— 一致性铁律 + EC-5 + FR-032 ② 同屏派生值
// ─────────────────────────────────────────────────────────────────────────────
describe('anchor-cascade — resolveEffectiveAnchorValues', () => {
  const base = { v: D('50'), confidence: D('8') };

  it('无人工位 → 三值全走派生, 三个人工态标记均 false', () => {
    const eff = resolveEffectiveAnchorValues(base, manualState());
    expect(eff.v).toEqual(D('50'));
    expect(eff.lLevel).toBe('L2');
    expect(eff.positionCap).toEqual(D('0.05'));
    expect([eff.vIsManual, eff.lLevelIsManual, eff.positionCapIsManual]).toEqual([
      false,
      false,
      false,
    ]);
  });

  it('🚨 EC-5 人工值恰好等于派生值 → 仍标记为人工态 (痕迹里保住「这个值是谁设的」)', () => {
    const eff = resolveEffectiveAnchorValues(base, manualState({ lLevelManual: 'L2' }));
    expect(eff.lLevel).toBe('L2');
    expect(eff.lLevelIsManual).toBe(true);
    expect(eff.derived.lLevel).toBe('L2');
  });

  it('EC-5 单票上限人工值等于派生值 → 同样仍为人工态', () => {
    const eff = resolveEffectiveAnchorValues(base, manualState({ positionCapManual: D('0.05') }));
    expect(eff.positionCapIsManual).toBe(true);
    expect(eff.positionCap).toEqual(D('0.05'));
  });

  it('L 层人工态 → 单票上限改从**人工 L 层**派生 (不是映射档)', () => {
    const eff = resolveEffectiveAnchorValues(base, manualState({ lLevelManual: 'L3' }));
    expect(eff.lLevel).toBe('L3');
    expect(eff.positionCap).toEqual(D('0.02'));
    expect(eff.derived.lLevel).toBe('L2');
  });

  it('FR-032 ② 同屏须展示的派生值随人工值一并返回', () => {
    const eff = resolveEffectiveAnchorValues(
      base,
      manualState({ lLevelManual: 'L1', positionCapManual: D('0.40') }),
    );
    expect(eff.derived.lLevel).toBe('L2');
    expect(eff.derived.positionCap).toEqual(D('0.25'));
    expect(eff.positionCap).toEqual(D('0.40'));
  });

  it('生效 V = COALESCE(v_manual, v), 无第二份生效值', () => {
    const eff = resolveEffectiveAnchorValues(base, manualState({ vManual: D('55') }));
    expect(eff.v).toEqual(D('55'));
    expect(eff.vIsManual).toBe(true);
  });

  it('L4 档无上限口径 → 生效上限 null (禁自造 0)', () => {
    const eff = resolveEffectiveAnchorValues({ v: D('50'), confidence: D('1') }, manualState());
    expect(eff.lLevel).toBe('L4');
    expect(eff.positionCap).toBeNull();
  });
});
