import type { AnnouncementDto, AnnouncementRangeQuery } from './marketdata.types.js';

/**
 * 公告端口 (043 US2)。理杏仁 `${market}/company/announcement` 主源 (指定证券区间内历次公告
 * 元数据: 公告日/文档 URL/标题/类型/分类标签…, 只存元数据不存 PDF 正文)。
 *
 * per-stock 区间抓取 (形态照抄 buyback `getBuybackRange(from,to)`): 单只 symbol 拉 [from, to]
 * 公告流序列 (date 升序), 供 backfill 回填历史 + delta 抓当日。理杏仁端点单数 stockCode (数组
 * → 400, 同 039 short-selling; **不用 metricsList** → 无 p1 #670 all-or-nothing 静默 0 行坑)。
 * **单请求无分页** (probe 10yr 单 POST 返全量), **≤10yr 硬上限** (>10yr → 403, 同 dividend)。
 * 无公告的标的 → 空数组 (不崩)。
 */
export const ANNOUNCEMENT_PORT = Symbol('ANNOUNCEMENT_PORT');

export interface AnnouncementPort {
  /** per-stock 区间抓取: 单只 symbol 拉 [from, to] 公告流序列, date 升序; 无数据 → 空数组。 */
  getAnnouncementRange(query: AnnouncementRangeQuery): Promise<AnnouncementDto[]>;
}
