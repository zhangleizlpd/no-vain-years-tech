import { describe, it, expect } from 'vitest';
import { briefSchema, T1_SEGMENT_KEYS, T2_SEGMENT_KEYS, T3_SEGMENT_KEYS } from './brief.schema';

/** 构造一个 T1 五段齐的最小合法 brief。 */
function fullT1(): Record<string, string> {
  return {
    problem: '行情页缺收藏，用户要反复搜索常看的股票',
    user_stories: 'P1 作为用户，我想收藏股票，以便快速访问 (Given 列表 When 点收藏 Then 入收藏)',
    functional_requirements: 'FR-001 提供收藏/取消收藏；FR-002 收藏列表持久',
    success_criteria: 'SC-001 收藏后 1 步可达',
    non_goals: '不做收藏分组',
  };
}

describe('brief.schema', () => {
  describe('段落 key 清单', () => {
    it('T1 = 五段核心必填 (problem/user_stories/functional_requirements/success_criteria/non_goals)', () => {
      expect(T1_SEGMENT_KEYS).toEqual([
        'problem',
        'user_stories',
        'functional_requirements',
        'success_criteria',
        'non_goals',
      ]);
    });

    it('T2 = 四接地段', () => {
      expect(T2_SEGMENT_KEYS).toEqual([
        'affected_surface',
        'constraints_guardrails',
        'data_model_sketch',
        'api_contract_sketch',
      ]);
    });

    it('T3 = 五可选段', () => {
      expect(T3_SEGMENT_KEYS).toEqual([
        'edge_cases',
        'nfr',
        'ui_notes',
        'open_questions',
        'phase_boundary',
      ]);
    });
  });

  describe('briefSchema 校验', () => {
    it('T1 齐 + 无 T2/T3 → pass (T2 全空仍合法)', () => {
      const parsed = briefSchema.safeParse(fullT1());
      expect(parsed.success).toBe(true);
    });

    it('T1 齐 + T2/T3 部分填 → pass', () => {
      const parsed = briefSchema.safeParse({
        ...fullT1(),
        affected_surface: 'markets 屏 + WatchlistItem 表',
        edge_cases: '重复收藏幂等',
      });
      expect(parsed.success).toBe(true);
    });

    it.each(T1_SEGMENT_KEYS)('缺 T1 段 %s → zod 拒', (key) => {
      const body = fullT1();
      delete body[key];
      const parsed = briefSchema.safeParse(body);
      expect(parsed.success).toBe(false);
    });

    it('T1 段为空白 string → zod 拒 (trim 后非空)', () => {
      const parsed = briefSchema.safeParse({ ...fullT1(), problem: '   ' });
      expect(parsed.success).toBe(false);
    });

    it('T1 段类型错 (非 string) → zod 拒', () => {
      const parsed = briefSchema.safeParse({ ...fullT1(), problem: 123 });
      expect(parsed.success).toBe(false);
    });

    it('T2 段提供但为空白 → zod 拒 (提供时同样非空)', () => {
      const parsed = briefSchema.safeParse({ ...fullT1(), affected_surface: '  ' });
      expect(parsed.success).toBe(false);
    });

    it('trim：合法段保留 trim 后内容', () => {
      const parsed = briefSchema.parse({ ...fullT1(), problem: '  有空白  ' });
      expect(parsed.problem).toBe('有空白');
    });
  });
});
