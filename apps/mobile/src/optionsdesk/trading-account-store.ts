// 081 T002 — 交易账户页「市场 × 分段」选择 store（zustand，进程内非持久）。
//
// 为什么是模块级 store 而不是组件 `useState`（plan §D5）：交易账户页是雷达经 Stack push 的
// 二级屏，返回即卸载 —— `useState` 会随屏一起丢，FR-004「同次使用内记住」就失效了。雷达
// `use-radar.ts` 能用 `useState` 是因为底部 Tab 屏常驻不卸载，🚫 别照搬。
//
// 非持久（不挂 `persist`）：进程存活期间记住，进程重启 / 网页刷新即回 `DEFAULT_TRADING_ACCOUNT_SELECTION`
// （spec Assumptions：刷新视同重启）。
//
// 🚨 **与雷达互相独立（FR-006）是结构性的**：本 store 与 `useRadar` 的 `useState` 是两份状态，
//    本文件 MUST NOT 读写 `useRadar` —— 在这里切市场不得带动雷达页签，反之亦然。
import { create } from 'zustand';

import type { RadarMarket } from './radar.rules';
import {
  DEFAULT_TRADING_ACCOUNT_SELECTION,
  type TradingAccountSegment,
  type TradingAccountSelection,
} from './trading-account.rules';

export interface TradingAccountState extends TradingAccountSelection {
  /** 只改市场一维，分段保持不变。 */
  selectMarket: (market: RadarMarket) => void;
  /** 只改分段一维，市场保持不变。 */
  selectSegment: (segment: TradingAccountSegment) => void;
}

export const useTradingAccountStore = create<TradingAccountState>()((set) => ({
  ...DEFAULT_TRADING_ACCOUNT_SELECTION,
  selectMarket: (market) => set({ market }),
  selectSegment: (segment) => set({ segment }),
}));
