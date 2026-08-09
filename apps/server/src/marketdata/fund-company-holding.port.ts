import type { FundCompanyHoldingDto, FundCompanyHoldingRangeQuery } from './marketdata.types.js';

/**
 * 基金公司持股报告期端口 (039 US2)。理杏仁 `hk/company/fund-collection-shareholders` 主源 (指定证券
 * 各基金公司口径按报告期的持仓/市值)。
 *
 * per-stock 区间抓取 (形态照抄 eod-bar `getBars(from,to)`): 单只 symbol 拉 [from, to] 报告期序列
 * (报告期×基金公司, reportDate 升序), 供 backfill 回填历史。理杏仁端点单数 stockCode (数组 → 400,
 * p2 探查报告实测); 无数据的标的 → 空数组 (不崩)。
 */
export const FUND_COMPANY_HOLDING_PORT = Symbol('FUND_COMPANY_HOLDING_PORT');

export interface FundCompanyHoldingPort {
  /** per-stock 区间抓取: 单只 symbol 拉 [from, to] 报告期序列 (报告期×基金公司), reportDate 升序; 无数据 → 空数组。 */
  getFundCompanyHoldingRange(query: FundCompanyHoldingRangeQuery): Promise<FundCompanyHoldingDto[]>;
}
