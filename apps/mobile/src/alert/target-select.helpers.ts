// 屏 4 预警对象选择纯函数（021 T019 / FR-M09）。板块标签 marketBadgeLabel 已提升
// `~/ui/market-badge.rules`（013/021 列表行共用）。复杂度均 O(n)。

export interface NameSegment {
  text: string;
  hit: boolean;
}

/**
 * 搜索结果股票名高亮分段（FR-M09 匹配文字高亮）：query 裁剪后取**首处**子串命中
 * （mockup 体例），切 前/命中/后 非空段；空 query / 未命中（如按代码搜）→ 单非 hit 段。
 */
export function splitNameHighlight(name: string, query: string): NameSegment[] {
  const q = query.trim();
  if (q === '') return [{ text: name, hit: false }];
  const idx = name.indexOf(q);
  if (idx === -1) return [{ text: name, hit: false }];
  const segments: NameSegment[] = [];
  if (idx > 0) segments.push({ text: name.slice(0, idx), hit: false });
  segments.push({ text: q, hit: true });
  if (idx + q.length < name.length) {
    segments.push({ text: name.slice(idx + q.length), hit: false });
  }
  return segments;
}
