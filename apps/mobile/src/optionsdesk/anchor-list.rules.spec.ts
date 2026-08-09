// 锚列表三态 + 单选筛选纯函数单测（logic-only，渲染走 T025 E2E）。
// 🚨 Guardrail 12 的前端半边在此锁死：**锚列表必须显示 excluded**（与雷达默认排除相反）。
import { describe, expect, it } from 'vitest';

import {
  ANCHOR_FILTERS,
  anchorFilterCounts,
  anchorRowState,
  daysOverdue,
  filterAnchors,
  selectAnchorFilter,
} from './anchor-list.rules';

type Row = { id: string; ticker: string; excluded: boolean; overdue: boolean };

const normal: Row = { id: '1', ticker: 'us:VICI', excluded: false, overdue: false };
const overdue: Row = { id: '2', ticker: 'us:TAP', excluded: false, overdue: true };
const excluded: Row = { id: '3', ticker: 'us:PSKY', excluded: true, overdue: false };
// 既 excluded 又 overdue —— excluded 优先（降级态压过状态态，同 mockup 帧 ⑤ 灰卡）。
const both: Row = { id: '4', ticker: 'us:XYZ', excluded: true, overdue: true };
const all = [normal, overdue, excluded, both];

describe('anchorRowState（三态同屏）', () => {
  it('未排除 ∧ 未逾期 → normal', () => {
    expect(anchorRowState(normal)).toBe('normal');
  });

  it('未排除 ∧ 逾期 → overdue（红标；FR-004 行不隐藏）', () => {
    expect(anchorRowState(overdue)).toBe('overdue');
  });

  it('excluded → excluded（即便同时逾期，排除态优先）', () => {
    expect(anchorRowState(excluded)).toBe('excluded');
    expect(anchorRowState(both)).toBe('excluded');
  });
});

describe('filterAnchors（chips 单选）', () => {
  it('🚨 Guardrail 12：默认「全部」照常返回 excluded 行（锚列表与雷达态度相反）', () => {
    const rows = filterAnchors(all, 'all');
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.id)).toContain('3');
  });

  it('「待复审」只留逾期行（含同时被排除的）', () => {
    expect(filterAnchors(all, 'pendingReview').map((r) => r.id)).toEqual(['2', '4']);
  });

  it('「已排除」只留 excluded 行', () => {
    expect(filterAnchors(all, 'excluded').map((r) => r.id)).toEqual(['3', '4']);
  });

  it('筛选后为空时返回空数组（屏侧据此区分「零锚」与「筛选无结果」两种空态）', () => {
    expect(filterAnchors([normal], 'excluded')).toEqual([]);
  });
});

describe('selectAnchorFilter（单选语义 —— 不是雷达那处的多选）', () => {
  it('点另一个 chip → 切过去', () => {
    expect(selectAnchorFilter('all', 'excluded')).toBe('excluded');
  });

  it('再点当前选中的 chip → 回落「全部」（单选下的取消态）', () => {
    expect(selectAnchorFilter('excluded', 'excluded')).toBe('all');
  });

  it('点「全部」恒为「全部」', () => {
    expect(selectAnchorFilter('pendingReview', 'all')).toBe('all');
  });

  it('三项齐备且顺序固定', () => {
    expect([...ANCHOR_FILTERS]).toEqual(['all', 'pendingReview', 'excluded']);
  });
});

describe('anchorFilterCounts（chip 上的计数）', () => {
  it('全部 / 待复审 / 已排除 各自计数', () => {
    expect(anchorFilterCounts(all)).toEqual({ all: 4, pendingReview: 2, excluded: 2 });
  });
});

describe('daysOverdue（逾期天数，纯日期差）', () => {
  it('逾期 → 正整数天', () => {
    expect(daysOverdue('2026-07-15', '2026-07-31')).toBe(16);
  });

  it('今天到期 → 0（不算逾期，由 server overdue 判据决定是否红标）', () => {
    expect(daysOverdue('2026-07-31', '2026-07-31')).toBe(0);
  });

  it('未到期 → 负数（调用方只在 overdue 时读它）', () => {
    expect(daysOverdue('2026-08-20', '2026-07-31')).toBe(-20);
  });

  it('next_review 为 null → null（无复审计划，不编造天数）', () => {
    expect(daysOverdue(null, '2026-07-31')).toBeNull();
  });
});
