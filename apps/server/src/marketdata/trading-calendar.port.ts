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

  /**
   * 该市场**最近一场已收盘交易日**（`YYYY-MM-DD`），即数据陈旧度判定的基准（062 T010,
   * FR-012 / `state_branch` 9）。`null` = **不可判定**，调用方按既有 fail-open 判当期档。
   *
   * 🚨 **两种 `null` 蓄意合流成一个值**：日历真的没有更早的行、以及「收盘上界落在覆盖声明
   * 之外」（= 这一段根本没填全，库里那个最大值不是真的最近一场）。对调用方而言两者是同一件
   * 事 —— **基准不可信**，而 MUST NOT 拿一个不可信的基准日去判陈旧（那会把「同步停了」悄悄
   * 判成「数据是新的」，或反过来把正常数据判成陈旧）。
   *
   * 🚨 **为什么落在端口而不是各消费方自己查**：它此前有**两份**同款实现（marketdata 的
   * `get-instrument-bars.usecase.ts` 与 optionsdesk 的 `last-closed-session.ts`），而 062 起
   * 判据多了「覆盖声明」这一维 —— 两份实现必然漂移，且漂移的表现只是档位悄悄错一档、不报错。
   *
   * @param now 绝对时刻（收盘上界按**交易所时区**求，见 `sessionWatermark`）。
   */
  lastClosedSession(market: string, now: Date): Promise<string | null>;
}
