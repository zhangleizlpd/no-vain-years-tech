// GOLDEN SAMPLE — UI badge 的纯函数规则半边（companion 于 MarketBadge.tsx）。索引见 docs/conventions/golden-sample-registry.md。
// 市场/板块小标签纯函数（自 021 target-select.helpers 提升共享，013/021 列表行共用）。
// A股段与 ~/alert/limit-price.rules 同口径（688/689 科创、300/301 创业、920/8x/4x 北交）；
// V1 主覆盖 A股个股，ETF/指数等边角按首位兜底（6→沪A / 其余→深A），允许不准
// （021 clarify #2 同精神）。非 cn 市场按 market 直标（hk→港 / us→美）。复杂度 O(1)。

/** 市场小标签（沪A/深A/科创/创业/北交/港/美）。market 缺省按 cn 板块段判。 */
export function marketBadgeLabel(code: string, market = 'cn'): string {
  if (market === 'hk') return '港';
  if (market === 'us') return '美';
  const seg3 = code.slice(0, 3);
  if (seg3 === '688' || seg3 === '689') return '科创';
  if (seg3 === '300' || seg3 === '301') return '创业';
  // 920 = 2025 起北交所新代码段（沪深京三所统一编码后的京市段）。
  if (seg3 === '920' || code.startsWith('8') || code.startsWith('4')) return '北交';
  if (code.startsWith('6')) return '沪A';
  return '深A';
}
