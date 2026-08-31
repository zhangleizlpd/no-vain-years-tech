import { describe, expect, it } from 'vitest';

import {
  asofBadgeLabel,
  DISPOSITION_LABEL,
  filterSubmissions,
  submissionFactsLine,
  submissionMarketCounts,
  toggleSubmissionSelection,
  visibleSelection,
} from './anchor-submission.rules';

// 072 T018 — 待审箱列表判定（FR-001 / US1）。logic-only：渲染 / 多选交互归 e2e。

describe('asofBadgeLabel — 口径日五档（sb-1~4）', () => {
  it('OK → 不出徽标（null，而不是一句「没问题」）', () => {
    expect(asofBadgeLabel('OK')).toBeNull();
  });

  it('四档可疑态各有各的话，两两互异 —— UNKNOWN MUST NOT 与 OK 合并', () => {
    const labels = (['TODAY', 'FUTURE', 'NON_TRADING', 'UNKNOWN'] as const).map(asofBadgeLabel);
    expect(labels.every((l) => typeof l === 'string' && l.length > 0)).toBe(true);
    expect(new Set(labels).size).toBe(4);
  });

  it('UNKNOWN 的文案说的是「日历没覆盖」而不是「没问题」（放行等于替日历做主）', () => {
    expect(asofBadgeLabel('UNKNOWN')).toContain('日历');
  });
});

describe('DISPOSITION_LABEL — refresh 不是更温和的 create', () => {
  it('两档文案互异，且 refresh 明说「覆盖」', () => {
    expect(DISPOSITION_LABEL.create).not.toBe(DISPOSITION_LABEL.refresh);
    expect(DISPOSITION_LABEL.refresh).toContain('覆盖');
  });
});

describe('submissionFactsLine — 事实行', () => {
  it('V / 口径日 / 方法 / 置信度 四段齐全且保持字符串原样（永不经 JS number）', () => {
    const line = submissionFactsLine({
      v: '49.3400',
      asof: '2026-08-30',
      method: 'weighted',
      confidence: '6.0',
    });
    expect(line).toBe('V 49.3400 · 口径日 2026-08-30 · weighted · 6.0');
  });

  it('尾零不被吞（49.3400 ≠ 49.34 —— 一旦经 number 就回不来了）', () => {
    const line = submissionFactsLine({
      v: '17.5000',
      asof: '2026-08-28',
      method: 'sotp',
      confidence: '8.0',
    });
    expect(line).toContain('17.5000');
    expect(line).toContain('8.0');
  });
});

describe('submissionMarketCounts / filterSubmissions — 市场 chips', () => {
  const items = [{ market: 'us' as const }, { market: 'us' as const }, { market: 'hk' as const }];

  it('all 是总数，不是「除 us/hk 之外的」', () => {
    expect(submissionMarketCounts(items)).toEqual({ all: 3, us: 2, hk: 1 });
  });

  it('空列表四个计数全 0（空态下 chips 不显示假数字）', () => {
    expect(submissionMarketCounts([])).toEqual({ all: 0, us: 0, hk: 0 });
  });

  it('筛选按 market 段切；all 返回全量副本（不是同一个引用）', () => {
    expect(filterSubmissions(items, 'us')).toHaveLength(2);
    expect(filterSubmissions(items, 'hk')).toHaveLength(1);
    const all = filterSubmissions(items, 'all');
    expect(all).toHaveLength(3);
    expect(all).not.toBe(items);
  });
});

describe('toggleSubmissionSelection — 不可变翻选', () => {
  it('不在集合里 → 加入；在 → 剔除', () => {
    const once = toggleSubmissionSelection(new Set<string>(), '1');
    expect([...once]).toEqual(['1']);
    expect([...toggleSubmissionSelection(once, '1')]).toEqual([]);
  });

  it('不改原集合（React state 安全）', () => {
    const before = new Set(['1']);
    toggleSubmissionSelection(before, '2');
    expect([...before]).toEqual(['1']);
  });
});

describe('visibleSelection — 看不见的选中项不许被驳回', () => {
  const selected = new Set(['1', '2', '3']);

  it('切市场 chip 后，只驳回当前可见的那些', () => {
    expect(visibleSelection(selected, ['1', '3'])).toEqual(['1', '3']);
  });

  it('可见集合与选中集无交集 → 空数组（驳回按钮据此置灰）', () => {
    expect(visibleSelection(selected, ['9'])).toEqual([]);
  });

  it('按可见顺序返回，且不含未选中的可见行', () => {
    expect(visibleSelection(selected, ['3', '9', '1'])).toEqual(['3', '1']);
  });
});
