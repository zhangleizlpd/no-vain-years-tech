import { describe, it, expect } from 'vitest';
import {
  shouldOfferChips,
  normalizeSuggestion,
  MAX_CHIPS,
  ESCAPE_HATCH_LABEL,
  RECOMMENDED_SUFFIX,
  type RawSuggestion,
} from './suggestion-gate.rules';

describe('suggestion-gate.rules / shouldOfferChips', () => {
  it('两闸过 + 非第一问 → 给 chips', () => {
    expect(shouldOfferChips({ turnIndex: 1, enumerable: true, defensibleRec: true })).toBe(true);
  });

  it('闸一挂 (开放问题，不可枚举) → 不给', () => {
    expect(shouldOfferChips({ turnIndex: 1, enumerable: false, defensibleRec: true })).toBe(false);
  });

  it('闸二挂 (无可辩护推荐) → 不给', () => {
    expect(shouldOfferChips({ turnIndex: 1, enumerable: true, defensibleRec: false })).toBe(false);
  });

  it('两闸全挂 → 不给', () => {
    expect(shouldOfferChips({ turnIndex: 2, enumerable: false, defensibleRec: false })).toBe(false);
  });

  it('第一问 (turnIndex=0) 即便两闸过 → 永不给 (反锚定)', () => {
    expect(shouldOfferChips({ turnIndex: 0, enumerable: true, defensibleRec: true })).toBe(false);
  });

  it('防御性：负 turnIndex 也不给', () => {
    expect(shouldOfferChips({ turnIndex: -1, enumerable: true, defensibleRec: true })).toBe(false);
  });
});

describe('suggestion-gate.rules / normalizeSuggestion', () => {
  function raw(overrides: Partial<RawSuggestion> = {}): RawSuggestion {
    return {
      question: '输出流走 SSE 流式还是一次性全文？',
      options: [{ label: '一次性全文' }, { label: 'SSE 流式', recommended: true }],
      ...overrides,
    };
  }

  it('推荐项排首位 + recommended=true（label 落库干净，「（推荐）」由前端渲染装饰）', () => {
    const out = normalizeSuggestion(raw());
    expect(out.options[0].label).toBe('SSE 流式');
    expect(out.options[0].recommended).toBe(true);
  });

  it('末位永远补逃生项「都不是/自己填」+ escapeHatch=true', () => {
    const out = normalizeSuggestion(raw());
    const last = out.options[out.options.length - 1];
    expect(last.label).toBe(ESCAPE_HATCH_LABEL);
    expect(last.escapeHatch).toBe(true);
    expect(last.recommended).toBe(false);
  });

  it('不预选：选项无 selected 字段 (recommended 仅呈现非预选)', () => {
    const out = normalizeSuggestion(raw());
    for (const opt of out.options) {
      expect(opt).not.toHaveProperty('selected');
    }
  });

  it('allow_freetext 恒 true (自由输入永驻)', () => {
    const out = normalizeSuggestion(raw({ allow_freetext: false }));
    expect(out.allow_freetext).toBe(true);
  });

  it('fill 透传 (采纳整段推荐 chip: label 短 / fill 装完整正文)', () => {
    const out = normalizeSuggestion(
      raw({ options: [{ label: '采纳（可再改）', recommended: true, fill: '完整成功标准正文' }] }),
    );
    expect(out.options[0].fill).toBe('完整成功标准正文');
    // label 落库干净（无「（推荐）」），fill 独立透传 (二者解耦)。
    expect(out.options[0].label).toBe('采纳（可再改）');
  });

  it('fill 缺省 / 等于 label → 不落 fill (前端回退 label)', () => {
    const out = normalizeSuggestion(
      raw({ options: [{ label: '一次性全文', fill: '一次性全文' }] }),
    );
    expect(out.options[0]).not.toHaveProperty('fill');
  });

  it('>4 内容项 → 钳到 MAX_CHIPS (含逃生项，内容钳到 3)', () => {
    const out = normalizeSuggestion(
      raw({
        options: [
          { label: 'A' },
          { label: 'B' },
          { label: 'C' },
          { label: 'D' },
          { label: 'E', recommended: true },
        ],
      }),
    );
    expect(out.options.length).toBe(MAX_CHIPS);
    // 推荐项 E 排首（label 干净），逃生项末位，中间留 2 个内容项
    expect(out.options[0].label).toBe('E');
    expect(out.options[0].recommended).toBe(true);
    expect(out.options[out.options.length - 1].escapeHatch).toBe(true);
  });

  it('单内容项 → 1 内容 + 1 逃生 = 2 (MIN)', () => {
    const out = normalizeSuggestion(raw({ options: [{ label: '唯一选项' }] }));
    expect(out.options.length).toBe(2);
    expect(out.options[0].label).toBe('唯一选项');
    expect(out.options[1].escapeHatch).toBe(true);
  });

  it('无 options → 只剩逃生项 (退化但不崩)', () => {
    const out = normalizeSuggestion(raw({ options: undefined }));
    expect(out.options.length).toBe(1);
    expect(out.options[0].escapeHatch).toBe(true);
  });

  it('模型在 label 内嵌「（推荐）」→ 落库剥成干净 label（前端单次渲染，不叠「（推荐）（推荐）」）', () => {
    const out = normalizeSuggestion(
      raw({ options: [{ label: `SSE 流式${RECOMMENDED_SUFFIX}`, recommended: true }] }),
    );
    expect(out.options[0].label).toBe('SSE 流式');
    expect(out.options[0].label).not.toContain(RECOMMENDED_SUFFIX);
  });

  it('multi_select 透传', () => {
    expect(normalizeSuggestion(raw({ multi_select: true })).multi_select).toBe(true);
    expect(normalizeSuggestion(raw({ multi_select: undefined })).multi_select).toBe(false);
  });

  it('question 透传', () => {
    expect(normalizeSuggestion(raw()).question).toBe('输出流走 SSE 流式还是一次性全文？');
  });

  it('原推荐项排序：非首位推荐项被提前', () => {
    const out = normalizeSuggestion(
      raw({
        options: [{ label: '甲' }, { label: '乙' }, { label: '丙', recommended: true }],
      }),
    );
    expect(out.options[0].recommended).toBe(true);
    expect(out.options[0].label).toBe('丙');
  });
});
