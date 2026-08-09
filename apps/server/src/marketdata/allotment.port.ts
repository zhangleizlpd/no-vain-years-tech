import type { AllotmentDto, AllotmentRangeQuery } from './marketdata.types.js';

/**
 * 配股事件端口 (041 US4)。理杏仁 `${market}/company/allotment` 主源 (指定证券历次配股: rights issue)。
 *
 * per-stock 区间抓取 (形态照抄 buyback / short-selling `getRange(from,to)`): 单只 symbol 拉
 * [from, to] 配股事件序列 (date 升序), 供 backfill 回填历史 + delta 抓当日。理杏仁端点单数
 * stockCode (数组 → 400, 同 039 short-selling; **不用 metricsList** → 无 p1 #670 all-or-nothing
 * 静默 0 行坑)。
 *
 * **港股配股极罕见 (零样本容错核心, US4/SC-004)**: p3 probe 扫 12 标的全 0 行、字段 schema 未知 →
 * DTO 用 `payload` Json 整存 vendor 行 (不预设 typed 列, plan Decision 5)。**预期多数标的 vendor 返 0
 * 行** → 空数组正常返回 (不崩不阻塞工作集其余标的)。
 */
export const ALLOTMENT_PORT = Symbol('ALLOTMENT_PORT');

export interface AllotmentPort {
  /** per-stock 区间抓取: 单只 symbol 拉 [from, to] 配股事件序列, date 升序; 无数据 → 空数组 (港股极罕见)。 */
  getAllotmentRange(query: AllotmentRangeQuery): Promise<AllotmentDto[]>;
}
