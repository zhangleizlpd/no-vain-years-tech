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

/**
 * 标的详情的**动态段模板** —— 只给 055 T016 的下钻用（`router.push({ pathname, params })`）。
 *
 * 🚨 带 query 参数时 MUST 走模板而不是上面那个拼好的串：`params` 里同时有 `symbol` 与几个
 *    预填值，交给 router 一起编码才不会把已编码的 `%3A` 再编一次（`us%253AACN` 解出来是
 *    `us%3AACN`，那是一个查不到的标的，**而屏照样渲染得出来**，只是无锚引导）。
 */
export const OPTIONSDESK_UNDERLYING_PATHNAME = '/(app)/optionsdesk/underlying/[symbol]' as const;

// ── 055 T010：标的链分析报表（FR-040 / plan D-UI-1） ─────────────────────────
//
// 🚨 同样长在 `/(app)/optionsdesk/` 下 —— 独立屏而非详情屏内嵌折叠块（`FR-040`：详情屏的
//    横滑手势覆盖其列表头部，报表自身也要横滑，同一手势树两个横滑消费者会相争），
//    合规门控随二级页栈继承（`SC-009`，🚫 屏内不另写判定）。

/** 链分析报表（标的详情入口进入；`symbol` 同上须转义）。 */
export function optionsdeskChainReportRoute(symbol: string) {
  return `/(app)/optionsdesk/chain-report/${encodeURIComponent(symbol)}` as const;
}

// ── 072 T018：锚待审箱（FR-001 / US1） ──────────────────────────────────────
//
// 🚨 同样长在 `/(app)/optionsdesk/` 下 —— 待审箱读的是估值锚的上游，与期权台同族且
//    同档合规门控（继承 `_layout` 那道 `MarketsRouteGuard`）。挂到 `/(app)/profile/…`
//    之类的地方 = 逃出门控且不会红：「我的」页那两栏靠渲染门，而深链靠路由门，两道门
//    盖的是同一件事的两个入口，缺一个就等于没门。

/** 待审估值列表（「我的」审批栏「查看全部」进入）。 */
export const OPTIONSDESK_ANCHOR_SUBMISSIONS_ROUTE =
  '/(app)/optionsdesk/anchor-submissions' as const;

/**
 * 待审详情（列表行 / 内嵌面板行点击进入）。`id` 是数字串，不含冒号，**无需转义** ——
 * 与 `underlying/[symbol]` 那条刻意不同，别照抄 `encodeURIComponent`（那会让 id 在
 * 服务端多一层解码假设）。
 */
export function optionsdeskAnchorSubmissionRoute(id: string) {
  return `/(app)/optionsdesk/anchor-submission/${id}` as const;
}

/** 冷启动结局（072 T021；待审列表题头 / 采纳回执进入）。同栈，继承同一道 MarketsRouteGuard。 */
export const OPTIONSDESK_ANCHOR_COLD_START_ROUTE = '/(app)/optionsdesk/anchor-cold-start' as const;
