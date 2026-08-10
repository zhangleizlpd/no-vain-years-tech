// 期权台的**价格量纲**呈现口径（2026-08-10 user 约定：价格默认保留 2 位小数）。
//
// 起因：server 下发的价格是 `Decimal(18,4)` 的序列化串（如 `42.4000` / `38.0400`），
// 各屏原样渲染 ⇒ 屏上出现 4 位小数，而价格的决策精度只到分。雷达行 / 锚卡 / 区间图 /
// 锚列表 / 锚表单只读区共 5 个屏各自渲染同一批值，故口径落**一处具名常量 + 一个纯函数**。
//
// 🚨 **只管价格量纲**（V / W / spot / 四区间边界）。百分数、Δ、σ、周化 / 年化 / 折年、
//    成交额各有自己的精度，`leg-row.rules.ts` 顶部明写「**量纲故意不同，别统一**」——
//    MUST NOT 拿本函数去统一它们。
//
// 🚨 **本函数不做 null / 缺数判定**。调用方各自已有降级分支（如 `formatSpot` 的
//    「行情不可用」、`parseZoneBounds` 的 `null`），把缺数语义塞进格式化函数会让那些
//    分支多一条隐形出口。

/** 价格显示的小数位。改口径只改这里。 */
export const PRICE_DISPLAY_DECIMALS = 2;

/**
 * 价格串 / 数 → 显示文本（保留 {@link PRICE_DISPLAY_DECIMALS} 位小数）。
 *
 * 🚨 **非数值原样回退，MUST NOT 兜成 `0.00`**：兜 `0` 是**编造一个价格**，比原样显示
 * 危险得多（承 045「禁显 0、显未知」的既定处置）。原样回退意味着上游一旦换了类型或
 * 下发了非数，屏幕上当场看得出来，而不是被格式化成一个像模像样的数字。
 */
export function formatPriceText(raw: string | number): string {
  const n = typeof raw === 'number' ? raw : Number.parseFloat(raw);
  return Number.isFinite(n) ? n.toFixed(PRICE_DISPLAY_DECIMALS) : String(raw);
}
