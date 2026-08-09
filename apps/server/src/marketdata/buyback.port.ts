import type { BuybackDto, BuybackRangeQuery } from './marketdata.types.js';

/**
 * 回购事件端口 (041 US1)。理杏仁 `${market}/company/repurchase` 主源 (指定证券历次回购事件:
 * 回购股数/价格区间/金额/方式/注销库存股数/决议以来累计比例…)。
 *
 * per-stock 区间抓取 (形态照抄 short-selling / eod-bar `getBars(from,to)`): 单只 symbol 拉
 * [from, to] 回购事件序列 (date 升序), 供 backfill 回填历史 + delta 抓当日。理杏仁端点单数
 * stockCode (数组 → 400, 同 039 short-selling; **不用 metricsList** → 无 p1 #670
 * all-or-nothing 静默 0 行坑)。无回购历史的标的 → 空数组 (不崩)。
 */
export const BUYBACK_PORT = Symbol('BUYBACK_PORT');

export interface BuybackPort {
  /** per-stock 区间抓取: 单只 symbol 拉 [from, to] 回购事件序列, date 升序; 无数据 → 空数组。 */
  getBuybackRange(query: BuybackRangeQuery): Promise<BuybackDto[]>;
}
