import type { FundamentalRangeQuery, FundamentalSnapshotDto } from './marketdata.types.js';

/**
 * 估值 + 历史分位端口 (FR-S05, US3)。理杏仁主源。
 *
 * FR-S11: 公司类型路由 (fsType) 在 adapter **内部**解析 (调 cn/company) 并缓存,
 * 端口对外签名不暴露 fsType — `getFundamentals(symbols)` 即可。
 */
export const FUNDAMENTAL_PORT = Symbol('FUNDAMENTAL_PORT');

export interface FundamentalPort {
  /** 批量按 symbols 返最近估值快照; 缺数据的 symbol 不在结果中。 */
  getFundamentals(symbols: string[]): Promise<FundamentalSnapshotDto[]>;
  /**
   * per-stock 区间抓取 (038 T013 seam#4): 单只 symbol 拉 [from, to] 历史日频估值序列 (多行),
   * tradeDate 升序。供 backfill 回填 10yr 历史; 公司类型未解析 / 缺数据 → 空数组 (不崩)。
   */
  getFundamentalsRange(query: FundamentalRangeQuery): Promise<FundamentalSnapshotDto[]>;
}
