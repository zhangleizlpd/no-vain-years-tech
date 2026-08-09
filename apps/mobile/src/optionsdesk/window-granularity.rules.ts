// 046 T020 — 区间时序「窗口 → 粒度」固定映射（FR-008 / FR-009, plan D3）。纯函数 → vitest。
//
// 分工（plan D3）：**呈现决策在客户端、聚合在 marketdata**。本文件只把用户选的窗口档翻成
// marketdata bars 端点**既有**的 `period` 查询参数；真正的 OHLC 时间桶聚合由服务端做。
//
// 🚨 三条 MUST NOT（都属「写错了也不会红、但错得很贵」）：
//   1. 禁在此实现任何抽稀 / LTTB 类**视觉近似**降采样（FR-009）—— 周 K / 月 K 是金融行业
//      标准口径，LTTB 会造出**不存在的价格点**，拿它画价格图是错的。
//   2. 禁为此引任何降采样库（SC-007 零新第三方运行时依赖）。本模块**零运行时 import**，
//      对 api-client 只取类型。
//   3. 禁在 optionsdesk 端点里重做一遍 period 聚合 —— 跨 ctx 调 marketdata use case 是
//      Q7-C 明禁，自己重写则是算法双写。
//
// 档位选型依据见 spec FR-009：目标函数是**各档 bar 数尽量一致**（压进 120–260 窄带），
// 而不是抄某家平台 —— 业界无唯一标准（Barchart 1Y=day / 5Y=month，TradingView 1Y=week，
// 同一档两家相反）。复杂度 O(1)：固定表查，与序列长度无关。
import type { MarketdataControllerBarsPeriod } from '@nvy/api-client';

/** 区间时序的四个窗口档（FR-008）；chip 行按此顺序呈现。 */
export const TIME_SERIES_WINDOWS = ['1Y', '3Y', '5Y', '10Y'] as const;

/** 窗口档字面量联合。 */
export type TimeSeriesWindow = (typeof TIME_SERIES_WINDOWS)[number];

/** 默认窗口 = 近 1 年日线（FR-008）。 */
export const DEFAULT_TIME_SERIES_WINDOW: TimeSeriesWindow = '1Y';

/**
 * 窗口 → bars 端点 `period` 的固定映射（FR-009）。值类型取 api-client 生成的枚举 ⇒
 * 端点 `period` 值域一改，这里**编译期**就红。注释里的根数是选型依据，非运行时约束。
 */
const WINDOW_TO_BARS_PERIOD: Record<TimeSeriesWindow, MarketdataControllerBarsPeriod> = {
  '1Y': 'day', // 约 252 根
  '3Y': 'week', // 约 156 根
  '5Y': 'week', // 约 260 根
  '10Y': 'month', // 约 120 根
};

/** 窗口档判别式 —— `barsPeriodForWindow` 的非抛错版，供恢复持久化 / 深链档位时先判再用。 */
export function isTimeSeriesWindow(value: string): value is TimeSeriesWindow {
  return (TIME_SERIES_WINDOWS as readonly string[]).includes(value);
}

/**
 * 取该窗口档要向 bars 端点请求的 `period`。
 *
 * 入参故意收成 `string` 而非 `TimeSeriesWindow`：真正会喂进未知值的是**持久化状态恢复 /
 * 深链**这类不受类型系统保护的来源，收成联合类型等于把这条边界让给了 `as`。
 *
 * 🚨 未知档位 **fail-closed 抛错，绝不回落 `day`**：静默回落会让 10 年窗按日线全量拉取
 * （约 2500 点），慢、费流量，且**不会有人发现** —— 无声地错正是这里要拦的。
 */
export function barsPeriodForWindow(window: string): MarketdataControllerBarsPeriod {
  if (!isTimeSeriesWindow(window)) {
    throw new Error(
      `未知的区间时序窗口档「${window}」—— 允许值：${TIME_SERIES_WINDOWS.join(' / ')}`,
    );
  }
  return WINDOW_TO_BARS_PERIOD[window];
}
