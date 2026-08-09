import type { GroupItem, ReorderGroupEntry } from '@nvy/api-client';

// 分组管理纯函数（013 US5 / FR-M06）。把当前组序 + 一次拖拽 / 隐藏切换折算成 EP5 批量
// reorder 的全量 ReorderGroupEntry[]（order = 新下标 0-based，visible 按需翻转）。
// 纯函数 → vitest 单测（per mono 测试分层 logic=vitest）。

/** 拖拽 from→to 重排后产出全量 entry（order=新下标，visible 维持）。越界 / from===to → 原序。 */
export function reorderEntriesAfterMove(
  groups: GroupItem[],
  from: number,
  to: number,
): ReorderGroupEntry[] {
  const next = [...groups];
  if (from >= 0 && from < next.length && to >= 0 && to < next.length && from !== to) {
    const [moved] = next.splice(from, 1);
    if (moved) next.splice(to, 0, moved);
  }
  return next.map((g, i) => ({ groupId: g.id, order: i, visible: g.visible }));
}

/** 翻转某组 visible，产出全量 entry（order 维持当前次序下标）。 */
export function reorderEntriesWithVisibilityToggled(
  groups: GroupItem[],
  groupId: string,
): ReorderGroupEntry[] {
  return groups.map((g, i) => ({
    groupId: g.id,
    order: i,
    visible: g.id === groupId ? !g.visible : g.visible,
  }));
}
