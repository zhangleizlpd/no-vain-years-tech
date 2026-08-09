import { describe, it, expect } from 'vitest';
import { isConverged } from './brief-gate.rules';
import { T1_SEGMENT_KEYS } from './brief.schema';

function fullT1(): Record<string, string> {
  return {
    problem: '动机',
    user_stories: 'P1 故事',
    functional_requirements: 'FR-001',
    success_criteria: 'SC-001',
    non_goals: '不做 X',
  };
}

describe('brief-gate.rules / isConverged', () => {
  it('T1 五段齐 → converged，missing 空', () => {
    const r = isConverged(fullT1());
    expect(r.converged).toBe(true);
    expect(r.missing).toEqual([]);
  });

  it('T2 全空 T1 齐 → 仍 converged (门绝不含 T2，SC-007)', () => {
    const r = isConverged({
      ...fullT1(),
      affected_surface: undefined,
      constraints_guardrails: undefined,
      data_model_sketch: undefined,
      api_contract_sketch: undefined,
    });
    expect(r.converged).toBe(true);
  });

  it('T2/T3 填了但 T1 缺一段 → 不 converged (T2 不补门)', () => {
    const body = { ...fullT1(), affected_surface: '一堆接地内容', edge_cases: 'X' };
    delete (body as Record<string, unknown>).problem;
    const r = isConverged(body);
    expect(r.converged).toBe(false);
    expect(r.missing).toEqual(['problem']);
  });

  it.each(T1_SEGMENT_KEYS)('缺 T1 段 %s → 列入 missing', (key) => {
    const body = fullT1();
    delete body[key];
    const r = isConverged(body);
    expect(r.converged).toBe(false);
    expect(r.missing).toContain(key);
  });

  it('多段缺 → missing 按 T1_SEGMENT_KEYS 顺序列出', () => {
    const r = isConverged({ user_stories: 'P1', success_criteria: 'SC-001' });
    expect(r.missing).toEqual(['problem', 'functional_requirements', 'non_goals']);
  });

  it('空白 string 段视为缺失', () => {
    const r = isConverged({ ...fullT1(), problem: '   ' });
    expect(r.converged).toBe(false);
    expect(r.missing).toEqual(['problem']);
  });

  it('非 string 段 (number/null) 视为缺失', () => {
    const r = isConverged({ ...fullT1(), problem: 42, non_goals: null });
    expect(r.missing).toEqual(['problem', 'non_goals']);
  });

  it('入参非对象 (null/undefined/string) → 全 T1 缺失，不抛', () => {
    expect(isConverged(null).missing).toEqual([...T1_SEGMENT_KEYS]);
    expect(isConverged(undefined).missing).toEqual([...T1_SEGMENT_KEYS]);
    expect(isConverged('not an object').converged).toBe(false);
  });
});
