import { Injectable } from '@nestjs/common';
import type { EmployeePort } from './employee.port.js';
import type { EmployeeDto, EmployeeRangeQuery } from './marketdata.types.js';
import {
  LixingerAdapterBase,
  lixDateOnlyHk,
  lixDateOnlyHkOrNull,
  lixNumToString,
} from './lixinger-adapter.base.js';
import { toLixinger } from './lixinger-symbol.rules.js';

/**
 * 理杏仁员工 adapter (042 US3, EMPLOYEE_PORT live 实现)。
 *
 * POST `/${market}/company/employee` body `{ token, stockCode, startDate, endDate? }` —— `stockCode`
 * **单只** (数组 `stockCodes` → HTTP 400, 同 041 事件流单数契约)。**不用 `metricsList`** → 无 p1 #670
 * all-or-nothing 静默 0 行坑。
 *
 * 响应结构 (p3 探查报告实测 hk:00700, prod 77 verified): 每报告期一条 `{date, declarationDate, stockId,
 * dataList[], source}`, `dataList` 是「维度头行 + 数据行」混合结构:
 *   {"date":"2024-12-31...","dataList":[
 *     {"itemName":"员工总数","value":58350,"displayType":"number"},            // 顶层有 value 行 (无 parentItemName)
 *     {"itemName":"30歲以下","parentItemName":"按年龄分","value":18415,...},   // 数据行
 *     {"itemName":"总流失率","value":14.3,"displayType":"percentage"},         // 顶层有 value 行
 *     ...],"source":"ds_task"}
 *
 * **解析规则** (plan Decision 3/6, probe 精确化):
 *  - 展开 dataList → typed 子行, per-报告期 metadata (date/declarationDate) 反规范化到每行。
 *  - **头行判别**: 跳过 iff `parentItemName == null && value == null` (纯顶层分组标签)。**有 parentItemName
 *    的行一律出** (value 可 null, 缺值容错); 顶层有 value 行 (员工总数/总流失率) parentItemName 落哨兵 `''`
 *    (Decision 6, NK 列 NOT NULL)。
 *  - **key 归一化**: parentItemName/itemName/displayType `.trim()` (vendor 带尾随空格, 如 "流失率按性别分 ",
 *    否则 NK 漏行 / 跨期同键不一致)。
 *  - **🔑 displayType 进自然键、原样保留、不去重** (Decision 6, probe 独有坑): 同名 `(parentItemName, itemName)`
 *    会出 **number + percentage 两行** (如「流失率按性别分‖男性」= {58812 number, 15.2 percentage}) → 解析时
 *    **两行都出** (NK 含 displayType 才能共存, 去重会丢一半)。
 *  - value 金融数值跨边界 `string|null` (FR-S08), executor 落库时 Decimal 列 string 直落。
 *  - **🕐 日期 HK-aware 归一** (M1, probe verified): 员工 `date` 为 `...+08:00` (裸 slice 已 HK-correct),
 *    但用与营收/股东同一 `lixDateOnlyHk` (+8h then date-only) 归一保跨维度对齐一致 (对 `+08:00` 幂等无害)。
 *
 * 摄取侧 live: backfill/delta 灌 PG EmployeeSnapshot (无 fsType → 无-Prisma, 不注 Prisma)。
 */
interface LixingerEmployeeDataRow {
  itemName?: unknown;
  parentItemName?: unknown;
  value?: unknown;
  displayType?: unknown;
}

interface LixingerEmployeeReport {
  date?: unknown;
  declarationDate?: unknown;
  dataList?: unknown;
}

/** vendor 文本 key → trim 归一; null/缺失 → 哨兵空串 '' (NK 列 NOT NULL, 顶层行/缺字段)。 */
function trimOrSentinel(v: unknown): string {
  return v === null || v === undefined ? '' : String(v).trim();
}

@Injectable()
export class LixingerEmployeeAdapter extends LixingerAdapterBase implements EmployeePort {
  async getEmployeeRange(query: EmployeeRangeQuery): Promise<EmployeeDto[]> {
    // 038 seam#1: 路径按 market 段插值 (/cn|/hk); 非 cn/hk 前缀 toLixinger 抛 UnsupportedLixingerMarketError。
    const { market, stockCode } = toLixinger(query.symbol);
    const body: Record<string, unknown> = { stockCode, startDate: query.from };
    if (query.to) body.endDate = query.to;

    const reports = await this.post<LixingerEmployeeReport>(`/${market}/company/employee`, body);

    const out: EmployeeDto[] = [];
    for (const report of reports) {
      // 报告期 metadata: date HK-aware 归一 (员工为 +08:00, 保跨维度对齐), declarationDate 可空亦 HK-aware。
      const date = lixDateOnlyHk(report.date);
      const declarationDate = lixDateOnlyHkOrNull(report.declarationDate);
      const dataList = Array.isArray(report.dataList)
        ? (report.dataList as LixingerEmployeeDataRow[])
        : [];
      for (const r of dataList) {
        // 头行判别: 纯顶层分组标签 (无 parentItemName + 无 value) → 跳过。
        const isHeaderRow = r.parentItemName == null && r.value == null;
        if (isHeaderRow) continue;
        out.push({
          date,
          declarationDate,
          // 有 parentItemName → trim 归一; 顶层有 value 行 (员工总数/总流失率) 无 parentItemName → 哨兵 ''。
          parentItemName: trimOrSentinel(r.parentItemName),
          itemName: trimOrSentinel(r.itemName),
          // displayType 进自然键 (number/percentage): trim 归一原样保留, 同名两行经此共存不去重 (Decision 6)。
          displayType: trimOrSentinel(r.displayType),
          value: lixNumToString(r.value),
        });
      }
    }

    // 端口契约: date 升序 (V8 稳定 sort — 同 date 内保 dataList 原序, 分类归组不打散)。
    return out.sort((a, b) => a.date.localeCompare(b.date));
  }
}
