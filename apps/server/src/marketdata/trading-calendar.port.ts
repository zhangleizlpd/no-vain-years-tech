import type { TradingDayStatus } from './trading-day.rules.js';

/**
 * 交易日历端口 (FR-S01, US6)。判断交易日 / backfill 迭代。
 * 本 feature 仅落接口 + Mock; live adapter → 016 (D1: 建议 Lixinger trade-day 同源)。
 *
 * 🚨 **读/写对照** (命名仅一词之差, 勿混): 本端口 `TradingCalendarPort` = **读**
 * (查 `trading_day` 判 gate); `TRADING_CALENDAR_SOURCE` (`trading-calendar-source.port.ts`)
 * = **写入源** (拉 vendor → 填 `trading_day`)。
 */
export const TRADING_CALENDAR_PORT = Symbol('TRADING_CALENDAR_PORT');

export interface TradingCalendarPort {
  /**
   * market + date(YYYY-MM-DD) → **交易日三态** (062 T006, FR-010)。
   *
   * 🚨 **蓄意没有布尔便捷方法** —— 原 `isTradingDay(market,date): Promise<boolean>` 已删除,
   * 不是「顺手改个名」: 布尔必然把「还没填到」折进「不是交易日」, 而那正是本 feature 在消灭的
   * 病根 (closed-world assumption)。留着旧方法 = 留坑; 删掉它才让 TS 编译器把**每一个**调用点
   * 逼出来显式处置 (`unknown` 的处置**按调用点语义分派**, 见 spec `state_branches` 5–9,
   * 不存在通用默认值)。判据本体在 `trading-day.rules.ts` 的 {@link classifyTradingDay}。
   */
  classify(market: string, date: string): Promise<TradingDayStatus>;
}
