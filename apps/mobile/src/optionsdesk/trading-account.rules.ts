// 081 T001 — 交易账户页（持仓 / 订单 / 报表骨架）的值域与默认值单点。vitest 覆盖。
//
// 🚨 **市场值域复用雷达的 `RADAR_MARKETS` / `RadarMarket`**（plan §D6）—— 那份集合与契约是
//    编译期双向绑定的（见 `radar.rules.ts` 注释）。🚫 MUST NOT 在这里手写 `['us', 'hk']`：
//    手抄一份就是 FR-015「加了受支持市场却忘了加页签」在本页的复发点。
// 📌 命名一律 `trading-account`，不用 `broker-account`（plan §D0）。
import { RADAR_MARKETS, type RadarMarket } from './radar.rules';

/** 分段值域。🚨 数组顺序 = 屏上显示顺序（FR-003：持仓 / 订单 / 报表）。 */
export const TRADING_ACCOUNT_SEGMENTS = ['positions', 'orders', 'reports'] as const;

export type TradingAccountSegment = (typeof TRADING_ACCOUNT_SEGMENTS)[number];

/** 交易账户页的一次选择（市场 × 分段）。 */
export interface TradingAccountSelection {
  market: RadarMarket;
  segment: TradingAccountSegment;
}

/**
 * 默认选择 = 首个受支持市场（美股）· 持仓。进程重启 / 网页刷新后回落到这里（plan §D5）。
 * `!` 同 `use-radar.ts` 的冷启动默认 —— 受支持市场集合由契约保证非空。
 */
export const DEFAULT_TRADING_ACCOUNT_SELECTION: Readonly<TradingAccountSelection> = {
  market: RADAR_MARKETS[0]!,
  segment: 'positions',
};
