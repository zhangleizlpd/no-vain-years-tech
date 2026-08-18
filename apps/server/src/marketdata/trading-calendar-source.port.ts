/**
 * 交易日历源端口 (044): market 区间 → 该市场交易日集, 供 `TradingCalendarSyncService`
 * 填充 `trading_day` 表 (populate/seed)。实现可为活源 (vendor kline 派生) / 静态离线日历 /
 * 二者组成的 fallback 链。
 *
 * 🚨 **读/写对照** (命名仅一词之差, 勿混): 本端口 `TradingCalendarSource` = **写入源**
 * (拉 vendor → 填 `trading_day`); `TRADING_CALENDAR_PORT` (`trading-calendar.port.ts`,
 * `DbTradingCalendarAdapter`) = **读** (查 `trading_day` 判 gate)。
 */
export const TRADING_CALENDAR_SOURCE = Symbol('TRADING_CALENDAR_SOURCE');

/**
 * **前瞻**日历源 token (062 T003, plan §D4)。与 {@link TRADING_CALENDAR_SOURCE} 同一个接口、
 * 同一个路由类, 只是 routes map 不同 —— 历史段问过去 (活源链), 前瞻段问未来 (权威年历)。
 *
 * 🚨 **两个 token 刻意分开而不是一个源打两段**: 活源 (腾讯指数 kline) 的判据是「某指数当日有
 * bar ⟺ 当日开市」的**反推**, 未来的 bar 不存在 ⇒ 它结构上答不了前瞻段。合成一个 token 就只
 * 能让 cn/hk 每天各多一条恒定的假失败 WARN (044 论证过的告警疲劳)。接线见
 * `marketdata.module.ts` 与 `createForwardCalendarSource`。
 */
export const TRADING_CALENDAR_FORWARD_SOURCE = Symbol('TRADING_CALENDAR_FORWARD_SOURCE');

/** `fetchTradingDates` 返回值: 交易日集 + **本次由链上哪层服务** (降级可观测, FR-014)。 */
export interface TradingCalendarFetchResult {
  /** 区间内交易日列表 (`YYYY-MM-DD`)。非交易日不出现。 */
  dates: string[];
  /**
   * 本次结果的**服务方自报家门** (如 `'tencent'` / `'static'` / `'mock'`)。每个 adapter 自报,
   * 链原样返回胜出节点的结果 → 心跳落库后由探针判「是否降级运行」(FR-014)。
   */
  servedBy: string;
}

export interface TradingCalendarSource {
  /**
   * market + 闭区间 [from, to] (均 `YYYY-MM-DD`) → 该市场区间内交易日 + 服务方。
   * 区间无交易日 → `dates` 空数组 (非 error)。取数失败 / 结果不可信 → **throw** (禁静默返空,
   * 否则链降不了级 —— 044 事故根因)。
   */
  fetchTradingDates(market: string, from: string, to: string): Promise<TradingCalendarFetchResult>;
}
