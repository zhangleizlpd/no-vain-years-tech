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
  /** market + date(YYYY-MM-DD) → 是否交易日。 */
  isTradingDay(market: string, date: string): Promise<boolean>;
}
