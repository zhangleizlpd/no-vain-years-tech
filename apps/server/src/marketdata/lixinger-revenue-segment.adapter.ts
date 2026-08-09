import { Injectable } from '@nestjs/common';
import type { RevenueSegmentPort } from './revenue-segment.port.js';
import type { RevenueSegmentDto, RevenueSegmentRangeQuery } from './marketdata.types.js';
import {
  LixingerAdapterBase,
  lixDateOnlyHk,
  lixDateOnlyHkOrNull,
  lixNumToString,
} from './lixinger-adapter.base.js';
import { toLixinger } from './lixinger-symbol.rules.js';

/**
 * 理杏仁营收构成 adapter (042 US1, REVENUE_SEGMENT_PORT live 实现)。
 *
 * POST `/${market}/company/operation-revenue-constitution` body `{ token, stockCode, startDate, endDate? }`
 * —— `stockCode` **单只** (数组 `stockCodes` → HTTP 400, 同 041 事件流单数契约)。**不用 `metricsList`** →
 * 无 p1 #670 all-or-nothing 静默 0 行坑。
 *
 * 响应结构 (p3 探查报告实测 hk:00700, prod 77 verified): 每报告期一条 `{date, declarationDate, currency,
 * dataList[]}`, `dataList` 是「维度头行 + 数据行」混合结构:
 *   {"date":"2024-12-30T16:00:00.000Z","currency":"CNY","dataList":[
 *     {"itemName":"按服務類型分"},                                              // 纯头行 (无 parentItemName + 无 value)
 *     {"itemName":"增值服務","parentItemName":"按服務類型分","revenue":3.19e11,"costs":1.37e11,"grossProfitMargin":0.5692},
 *     {"itemName":"合計","revenue":6.6e11,...}]}                                // 顶层有 value 行 (无 parentItemName)
 *
 * **解析规则** (plan Decision 3, probe 精确化):
 *  - 展开 dataList → typed 子行, per-报告期 metadata (date/declarationDate/currency) 反规范化到每行。
 *  - **头行判别**: 跳过 iff `parentItemName == null && revenue == null && costs == null &&
 *    grossProfitMargin == null` (纯顶层分组标签)。**有 parentItemName 的行一律出** (value 可 null ——
 *    HSBC "按地區分" 下英國/香港等有 parent 缺 revenue = 缺值数据行, 落 null 不丢); 顶层有 value 行
 *    (合計) parentItemName 落哨兵 `''` (Decision 6, NK 列 NOT NULL)。
 *  - **key 归一化**: parentItemName/itemName `.trim()` (vendor 带尾随空格, 如 "按年龄分 ", 否则量化
 *    GROUP BY parentItemName 漏行、跨期同组 key 不一致)。
 *  - **revenue/costs signed 可负** (probe 实证 HSBC 企業中心 −1e10, 别取绝对值/过滤负数); 金融数值跨边界
 *    一律 `string|null` (FR-S08), executor 落库时 Decimal 列 string 直落。
 *  - **🕐 日期 HK-aware 归一** (M1, probe verified): 营收 `date` 为 UTC `...T16:00:00.000Z` (= 次日 00:00+08 HK)
 *    → 裸 `slice(0,10)` off-by-one 少 1 天 → 用 `lixDateOnlyHk` (+8h then date-only) 与员工/股东 `+08:00`
 *    日期对齐、防跨维度 join 错位 (plan §风险 #6)。
 *
 * 摄取侧 live: backfill/delta 灌 PG RevenueSegment (无 fsType → 无-Prisma, 不注 Prisma)。
 */
interface LixingerRevenueSegmentDataRow {
  itemName?: unknown;
  parentItemName?: unknown;
  revenue?: unknown;
  costs?: unknown;
  grossProfitMargin?: unknown;
}

interface LixingerRevenueSegmentReport {
  date?: unknown;
  declarationDate?: unknown;
  currency?: unknown;
  dataList?: unknown;
}

/** vendor 文本 key → trim 归一; null/缺失 → 哨兵空串 '' (NK 列 NOT NULL, 顶层行/缺 parentItemName)。 */
function trimOrSentinel(v: unknown): string {
  return v === null || v === undefined ? '' : String(v).trim();
}

@Injectable()
export class LixingerRevenueSegmentAdapter
  extends LixingerAdapterBase
  implements RevenueSegmentPort
{
  async getRevenueSegmentRange(query: RevenueSegmentRangeQuery): Promise<RevenueSegmentDto[]> {
    // 038 seam#1: 路径按 market 段插值 (/cn|/hk); 非 cn/hk 前缀 toLixinger 抛 UnsupportedLixingerMarketError。
    const { market, stockCode } = toLixinger(query.symbol);
    const body: Record<string, unknown> = { stockCode, startDate: query.from };
    if (query.to) body.endDate = query.to;

    const reports = await this.post<LixingerRevenueSegmentReport>(
      `/${market}/company/operation-revenue-constitution`,
      body,
    );

    const out: RevenueSegmentDto[] = [];
    for (const report of reports) {
      // 报告期 metadata: date HK-aware 归一 (营收为 UTC-Z, 防 off-by-one), declarationDate 可空亦 HK-aware。
      const date = lixDateOnlyHk(report.date);
      const declarationDate = lixDateOnlyHkOrNull(report.declarationDate);
      const currency = lixNumToString(report.currency);
      const dataList = Array.isArray(report.dataList)
        ? (report.dataList as LixingerRevenueSegmentDataRow[])
        : [];
      for (const r of dataList) {
        // 头行判别: 纯顶层分组标签 (无 parentItemName + 三 value 字段皆缺) → 跳过。
        const isHeaderRow =
          r.parentItemName == null &&
          r.revenue == null &&
          r.costs == null &&
          r.grossProfitMargin == null;
        if (isHeaderRow) continue;
        out.push({
          date,
          declarationDate,
          currency,
          // 有 parentItemName → trim 归一; 顶层有 value 行 (合計) 无 parentItemName → 哨兵 ''。
          parentItemName: trimOrSentinel(r.parentItemName),
          itemName: trimOrSentinel(r.itemName),
          revenue: lixNumToString(r.revenue), // signed 可负 (String(number) 天然保号)
          costs: lixNumToString(r.costs),
          grossProfitMargin: lixNumToString(r.grossProfitMargin),
        });
      }
    }

    // 端口契约: date 升序 (V8 稳定 sort — 同 date 内保 dataList 原序, 分部归组不打散)。
    return out.sort((a, b) => a.date.localeCompare(b.date));
  }
}
