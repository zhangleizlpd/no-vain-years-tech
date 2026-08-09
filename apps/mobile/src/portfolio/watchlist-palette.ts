// 自选项颜色标记调色板（013 FR-M08）。6 色，避开红/绿不与涨跌色（quote.*）冲突，
// 与 design handoff WatchlistKit PALETTE 对齐。**存储值 = key**（'blue'…，落 WatchlistItemView.color）；
// 视觉 hex 落 theme/index.ts colors.tag.*（NativeWind `bg-tag-*` class）。key→className 静态映射
// 让 NativeWind 编译期能扫到全部 class（动态拼 class 会被 tree-shake 丢失）。

export interface TagColor {
  /** 持久化值（WatchlistItemView.color）。 */
  key: string;
  /** 中文标签（菜单 a11y）。 */
  name: string;
  /** 色块 className（静态字面量，NativeWind 可扫）。 */
  dotClass: string;
}

export const TAG_COLORS: readonly TagColor[] = [
  { key: 'blue', name: '蓝', dotClass: 'bg-tag-blue' },
  { key: 'teal', name: '青', dotClass: 'bg-tag-teal' },
  { key: 'purple', name: '紫', dotClass: 'bg-tag-purple' },
  { key: 'pink', name: '粉', dotClass: 'bg-tag-pink' },
  { key: 'orange', name: '橙', dotClass: 'bg-tag-orange' },
  { key: 'gray', name: '灰', dotClass: 'bg-tag-gray' },
];

/** color key → 色块 className；未知 / null → null（不渲染色点）。 */
export function tagDotClass(color: string | null | undefined): string | null {
  if (color == null) return null;
  return TAG_COLORS.find((t) => t.key === color)?.dotClass ?? null;
}
