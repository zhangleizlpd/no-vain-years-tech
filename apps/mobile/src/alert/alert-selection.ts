// 多选删除模式纯函数（021 T017 / FR-M05，屏 1b + 屏 5 多选态共用）：选中集 = id Set
// 不可变翻转。全选语义 = 已全选再点清空（mockup DeleteFooter 行为）。复杂度均 O(n)。
// 纯函数 vitest；屏内编排走 Playwright（per mono 测试分层）。

/** 单项翻选（不可变；in→剔除 / out→加入）。 */
export function toggleSelection(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** 是否全选（空列表恒 false → 全选行不亮、删除保持 disabled）。 */
export function isAllSelected(selected: ReadonlySet<string>, ids: readonly string[]): boolean {
  return ids.length > 0 && ids.every((id) => selected.has(id));
}

/** 全选行点按：已全选 → 清空；否则 → 全选（仅含当前列表 ids，剔除已删残留）。 */
export function toggleSelectAll(
  selected: ReadonlySet<string>,
  ids: readonly string[],
): Set<string> {
  return isAllSelected(selected, ids) ? new Set() : new Set(ids);
}
