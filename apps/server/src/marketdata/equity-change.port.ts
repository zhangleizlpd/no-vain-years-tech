import type { EquityChangeDto, EquityChangeRangeQuery } from './marketdata.types.js';

/**
 * 股本变动事件端口 (041 US2)。理杏仁 `${market}/company/equity-change` 主源 (指定证券历次
 * issued capital 变动: 总股本/H 股股本/变动原因/公告日)。
 *
 * per-stock 区间抓取 (形态照抄 buyback / short-selling `getRange(from,to)`): 单只 symbol 拉
 * [from, to] 股本变动事件序列 (date 升序), 供 backfill 回填历史 + delta 抓当日。理杏仁端点单数
 * stockCode (数组 → 400, 同 039 short-selling; **不用 metricsList** → 无 p1 #670
 * all-or-nothing 静默 0 行坑)。无股本变动历史的标的 → 空数组 (不崩)。
 */
export const EQUITY_CHANGE_PORT = Symbol('EQUITY_CHANGE_PORT');

export interface EquityChangePort {
  /** per-stock 区间抓取: 单只 symbol 拉 [from, to] 股本变动事件序列, date 升序; 无数据 → 空数组。 */
  getEquityChangeRange(query: EquityChangeRangeQuery): Promise<EquityChangeDto[]>;
}
