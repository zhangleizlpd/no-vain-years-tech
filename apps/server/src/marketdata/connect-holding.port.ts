import type { ConnectHoldingPoint, ConnectHoldingRangeQuery } from './marketdata.types.js';

/**
 * 南向持股日频端口 (039 US1)。理杏仁 `hk/company/mutual-market` 主源 (互联互通南向持股)。
 *
 * per-stock 区间抓取 (形态照抄 eod-bar `getBars(from,to)`): 单只 symbol 拉 [from, to] 南向持股
 * 日频序列 (date 升序)。理杏仁端点单数 stockCode。仅 ~600 港股通标的有数据; 非港股通标的
 * vendor 返 0 行 → 空数组 (不崩, executor 零落库不建行, spec state_branch「南向非成分标的空数据」)。
 */
export const CONNECT_HOLDING_PORT = Symbol('CONNECT_HOLDING_PORT');

export interface ConnectHoldingPort {
  /** per-stock 区间抓取: 单只 symbol 拉 [from, to] 南向持股日频序列, date 升序; 无数据 → 空数组。 */
  getConnectHoldingRange(query: ConnectHoldingRangeQuery): Promise<ConnectHoldingPoint[]>;
}
