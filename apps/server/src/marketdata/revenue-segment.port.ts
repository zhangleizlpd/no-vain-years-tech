import type { RevenueSegmentDto, RevenueSegmentRangeQuery } from './marketdata.types.js';

/**
 * 营收构成端口 (042 US1)。理杏仁 `${market}/company/operation-revenue-constitution` 主源 (指定证券
 * 各报告期分部级营收: dataList 展开为 {parentItemName, itemName, revenue, costs, grossProfitMargin}
 * typed 子行, 报告期 metadata date/declarationDate/currency 反规范化到每行)。
 *
 * per-stock 区间抓取 (形态照抄 buyback / shareholder-change `getRange(from,to)`): 单只 symbol 拉
 * [from, to] 报告期分部营收序列 (date 升序), 供 backfill 回填历史报告期 + delta 抓当期。理杏仁端点单数
 * stockCode (数组 → 400, 同 041 事件流; **不用 metricsList** → 无 p1 #670 all-or-nothing 静默 0 行坑)。
 * vendor dataList 是「维度头行 + 数据行」混合结构 (plan Decision 3): adapter 跳纯头行、有 parentItemName
 * 的行一律出 (value 可 null)、顶层有 value 行 parentItemName 落哨兵 '' 、key `.trim()` 归一。无营收披露
 * 标的 → 空数组 (不崩)。
 */
export const REVENUE_SEGMENT_PORT = Symbol('REVENUE_SEGMENT_PORT');

export interface RevenueSegmentPort {
  /** per-stock 区间抓取: 单只 symbol 拉 [from, to] 报告期分部营收序列, date 升序; 无数据 → 空数组。 */
  getRevenueSegmentRange(query: RevenueSegmentRangeQuery): Promise<RevenueSegmentDto[]>;
}
