// 045 T022 — 锚列表三态 + 单选筛选纯函数。
//
// 🚨 Guardrail 12：**锚列表必须显示 `excluded` 的锚并带 `excludeReason`**（FR-005），与雷达
//    默认把它排除掉的态度**相反** —— 两处不共用查询、也不共用这里的筛选。
import type { AnchorResponse } from '@nvy/api-client';

/** chips 单选（雷达那处才是多选）。顺序即渲染顺序。 */
export const ANCHOR_FILTERS = ['all', 'pendingReview', 'excluded'] as const;
export type AnchorFilter = (typeof ANCHOR_FILTERS)[number];

/** 行态：正常 / 逾期红标 / 已排除，三态同屏（mockup 帧 ⑤）。 */
export type AnchorRowState = 'normal' | 'overdue' | 'excluded';

type AnchorFlags = Pick<AnchorResponse, 'excluded' | 'overdue'>;

/**
 * excluded 优先于 overdue —— 已排除是「不参与交易」的降级态，压过「该复审了」的状态态；
 * 两者同时成立时卡片按已排除渲染（逾期天数仍在行内可读，FR-004「字段照常可读」）。
 */
export function anchorRowState(anchor: AnchorFlags): AnchorRowState {
  if (anchor.excluded) return 'excluded';
  if (anchor.overdue) return 'overdue';
  return 'normal';
}

export function filterAnchors<T extends AnchorFlags>(
  items: readonly T[],
  filter: AnchorFilter,
): T[] {
  if (filter === 'pendingReview') return items.filter((a) => a.overdue);
  if (filter === 'excluded') return items.filter((a) => a.excluded);
  // 'all' —— excluded 照常在列（Guardrail 12）。
  return [...items];
}

export function anchorFilterCounts(items: readonly AnchorFlags[]): Record<AnchorFilter, number> {
  return {
    all: items.length,
    pendingReview: items.filter((a) => a.overdue).length,
    excluded: items.filter((a) => a.excluded).length,
  };
}

/** 单选语义：点当前选中的 chip = 取消，回落「全部」。 */
export function selectAnchorFilter(current: AnchorFilter, tapped: AnchorFilter): AnchorFilter {
  if (tapped === 'all') return 'all';
  return current === tapped ? 'all' : tapped;
}

/** UTC 解析，避开本地时区把 `YYYY-MM-DD` 偏移一天。 */
function ymdToUtcMs(ymd: string): number {
  return Date.parse(`${ymd}T00:00:00.000Z`);
}

/**
 * 逾期天数 = today − next_review（正数即逾期）。`next_review` 为 null ⇒ 无复审计划，
 * 返 null（不编造天数）。是否红标由 server 的 `overdue` 判据决定，这里只负责「逾期几天」的展示。
 */
export function daysOverdue(nextReview: string | null, today: string): number | null {
  if (!nextReview) return null;
  const due = ymdToUtcMs(nextReview);
  const now = ymdToUtcMs(today);
  if (!Number.isFinite(due) || !Number.isFinite(now)) return null;
  return Math.round((now - due) / 86_400_000);
}
