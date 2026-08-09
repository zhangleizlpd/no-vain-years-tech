import type { FinancialMetricDto, FinancialsRangeQuery } from './marketdata.types.js';

/**
 * 财报衍生端口 (FR-S05, US3)。理杏仁主源 (ROE / 毛利率 / EPS / BPS 等)。
 */
export const FINANCIALS_PORT = Symbol('FINANCIALS_PORT');

export interface FinancialsPort {
  /** 批量按 symbols 返最近报告期财务指标; 缺数据的 symbol 不在结果中。 */
  getFinancials(symbols: string[]): Promise<FinancialMetricDto[]>;
  /**
   * per-stock 区间抓取 (038 T013 seam#4): 单只 symbol 拉 [from, to] 多期财报序列 (多期),
   * reportPeriod 升序。供 backfill 回填历史; 公司类型未解析 / 缺数据 → 空数组 (不崩)。
   */
  getFinancialsRange(query: FinancialsRangeQuery): Promise<FinancialMetricDto[]>;
}
