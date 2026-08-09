import type { VolatilityPoint, VolatilityRangeQuery } from './marketdata.types.js';

/**
 * 波动率日频端口 (040 US1)。理杏仁 `hk/company/volatility` 主源 (指定证券按回看窗口的每日
 * 年化历史波动率序列)。
 *
 * per-stock × 单窗口区间抓取 (形态照抄 short-selling `getShortSellingRange(from,to)`): 单只
 * symbol × 单 `volatilityDays` 拉 [from, to] 波动率日频序列 (date 升序), 供 backfill 回填多年
 * 历史 + delta 抓当日。多窗口 = executor 对 `VOLATILITY_WINDOWS` 循环 (每窗口一次调用)。理杏仁
 * 端点单数 stockCode + **volatilityDays 单数 number** (数组 → 400, p3 探查报告实测); 无数据的
 * 标的 → 空数组 (不崩)。
 */
export const VOLATILITY_PORT = Symbol('VOLATILITY_PORT');

export interface VolatilityPort {
  /** per-stock × 单窗口区间抓取: 单只 symbol × 单 volatilityDays 拉 [from, to] 波动率日频序列, date 升序; 无数据 → 空数组。 */
  getVolatilityRange(query: VolatilityRangeQuery): Promise<VolatilityPoint[]>;
}
