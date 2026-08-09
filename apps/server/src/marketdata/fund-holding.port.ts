import type { FundHoldingDto, FundHoldingRangeQuery } from './marketdata.types.js';

/**
 * 公募基金持股报告期端口 (039 US2)。理杏仁 `hk/company/fund-shareholders` 主源 (指定证券各基金
 * 按报告期的持仓/市值/净值占比)。
 *
 * per-stock 区间抓取 (形态照抄 eod-bar `getBars(from,to)`): 单只 symbol 拉 [from, to] 报告期序列
 * (多期 × 多基金, reportDate 升序), 供 backfill 回填历史。理杏仁端点单数 stockCode (数组 → 400,
 * p2 探查报告实测); 无数据的标的 → 空数组 (不崩)。**真·大表** (单股 5yr ~19500 行, 报告期×基金)。
 */
export const FUND_HOLDING_PORT = Symbol('FUND_HOLDING_PORT');

export interface FundHoldingPort {
  /** per-stock 区间抓取: 单只 symbol 拉 [from, to] 报告期序列 (报告期×基金), reportDate 升序; 无数据 → 空数组。 */
  getFundHoldingRange(query: FundHoldingRangeQuery): Promise<FundHoldingDto[]>;
}
