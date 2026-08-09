import type { ShortSellingPoint, ShortSellingRangeQuery } from './marketdata.types.js';

/**
 * 做空日频端口 (039 US1)。理杏仁 `hk/company/short-selling` 主源 (指定证券每日做空股数/金额)。
 *
 * per-stock 区间抓取 (形态照抄 eod-bar `getBars(from,to)`): 单只 symbol 拉 [from, to] 做空日频
 * 序列 (date 升序), 供 backfill 回填历史 + delta 抓当日。理杏仁端点单数 stockCode (数组 → 400,
 * p2 探查报告实测); 无数据的标的 → 空数组 (不崩)。
 */
export const SHORT_SELLING_PORT = Symbol('SHORT_SELLING_PORT');

export interface ShortSellingPort {
  /** per-stock 区间抓取: 单只 symbol 拉 [from, to] 做空日频序列, date 升序; 无数据 → 空数组。 */
  getShortSellingRange(query: ShortSellingRangeQuery): Promise<ShortSellingPoint[]>;
}
