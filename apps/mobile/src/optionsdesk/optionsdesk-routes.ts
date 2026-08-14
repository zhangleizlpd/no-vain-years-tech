// 045 T020 — optionsdesk 路由常量单源（纯常量，无副作用）。app/ 树下的 Stack / push 一律引
// 这里的常量，避免路由字符串散落手写漂移（同 ideation-routes.ts 体例）。
//
// 期权台 = 底部 tab 落地屏（雷达）+ 一层二级页栈（锚管理列表 / 锚表单）。整栈受 markets 合规
// 门控（`MarketsRouteGuard` 挂在 optionsdesk/_layout，见 ~/core/markets-gate MARKETS_SURFACES
// 的 `route-stack` 一条 —— 栈内新增路由不需要再登记一条）。

/** 期权台 tab 落地屏（击球区雷达）。 */
export const OPTIONSDESK_RADAR_ROUTE = '/(app)/(tabs)/optionsdesk' as const;

/** 锚管理列表（二级页，雷达题头 ⚙ 进入）。 */
export const OPTIONSDESK_ANCHORS_ROUTE = '/(app)/optionsdesk/anchors' as const;

/** 建锚表单（锚管理题头 ＋ 进入）。 */
export const OPTIONSDESK_ANCHOR_NEW_ROUTE = '/(app)/optionsdesk/anchor-new' as const;

/** 编辑锚表单（锚列表行点击 / EC-7「去编辑既有锚」进入）。 */
export function optionsdeskAnchorEditRoute(id: string) {
  return `/(app)/optionsdesk/anchor/${id}` as const;
}

// ── 046 T023：两个新屏（FR-021 / FR-022） ────────────────────────────────────
//
// 🚨 两条都刻意长在 `/(app)/optionsdesk/` 下 —— 期权台二级页栈，**继承 `_layout` 那道
//    `MarketsRouteGuard`**（`MARKETS_SURFACES` 的 `route-stack` 一条已覆盖，不需再登记）。
//    挂到别处 = 逃出门控且不会红；结构前提由 `optionsdesk-routes.spec.ts` 守着。

/** 波动温度计 P7（雷达题头 🌡 / 标的详情「全景 ›」进入）。 */
export const OPTIONSDESK_THERMOMETER_ROUTE = '/(app)/optionsdesk/thermometer' as const;

/**
 * 标的详情（上半）。`symbol` = canonical `market:code` —— 冒号在路径段里**必须转义**，
 * 否则 `us:AAPL` 会被当成 scheme 前缀解析（web 上尤甚）。expo-router 侧读参自动解码。
 */
export function optionsdeskUnderlyingRoute(symbol: string) {
  return `/(app)/optionsdesk/underlying/${encodeURIComponent(symbol)}` as const;
}

// ── 055 T010：标的链分析报表（FR-040 / plan D-UI-1） ─────────────────────────
//
// 🚨 同样长在 `/(app)/optionsdesk/` 下 —— 独立屏而非详情屏内嵌折叠块（`FR-040`：详情屏的
//    横滑手势覆盖其列表头部，报表自身也要横滑，同一手势树两个横滑消费者会相争），
//    合规门控随二级页栈继承（`SC-009`，🚫 屏内不另写判定）。

/** 链分析报表（标的详情入口进入；`symbol` 同上须转义）。 */
export function optionsdeskChainReportRoute(symbol: string) {
  return `/(app)/optionsdesk/chain-report/${encodeURIComponent(symbol)}` as const;
}
