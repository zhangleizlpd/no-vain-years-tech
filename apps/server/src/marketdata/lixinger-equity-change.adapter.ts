import { Injectable } from '@nestjs/common';
import type { EquityChangePort } from './equity-change.port.js';
import type { EquityChangeDto, EquityChangeRangeQuery } from './marketdata.types.js';
import {
  LixingerAdapterBase,
  lixDateOnly,
  lixDateOnlyOrNull,
  lixNumToString,
} from './lixinger-adapter.base.js';
import { toLixinger } from './lixinger-symbol.rules.js';

/**
 * 理杏仁股本变动事件 adapter (041 US2, EQUITY_CHANGE_PORT live 实现)。
 *
 * POST `/${market}/company/equity-change` body `{ token, stockCode, startDate, endDate? }` ——
 * `stockCode` **单只** (数组 `stockCodes` → HTTP 400, 同 039 short-selling 单数契约)。**不用
 * `metricsList`** (返回固定扁平字段) → 无 p1 #670 all-or-nothing 静默 0 行坑。
 *
 * 响应字段 (p3 探查报告实测 hk:00700):
 *   {"date":"2024-12-31...","declarationDate":"2025-01-07...","capitalization":9224914953,
 *    "capitalizationH":9224914953,"changeReason":"定期報告"}。
 * 金融数值跨边界一律 string|null (FR-S08); executor 落库时 Decimal 列 string 直落 / 可空 Date
 * 列 (declarationDate) toDateOnly 转换。摄取侧 live: backfill/delta 灌 PG EquityChange
 * (无 fsType → 无-Prisma, 不注 Prisma)。
 */
interface LixingerEquityChangeRow {
  date?: unknown;
  capitalization?: unknown;
  capitalizationH?: unknown;
  changeReason?: unknown;
  declarationDate?: unknown;
}

@Injectable()
export class LixingerEquityChangeAdapter extends LixingerAdapterBase implements EquityChangePort {
  async getEquityChangeRange(query: EquityChangeRangeQuery): Promise<EquityChangeDto[]> {
    // 038 seam#1: 路径按 market 段插值 (/cn|/hk); 非 cn/hk 前缀 toLixinger 抛 UnsupportedLixingerMarketError。
    const { market, stockCode } = toLixinger(query.symbol);
    const body: Record<string, unknown> = { stockCode, startDate: query.from };
    if (query.to) body.endDate = query.to;

    const rows = await this.post<LixingerEquityChangeRow>(`/${market}/company/equity-change`, body);

    return rows
      .map(
        (r): EquityChangeDto => ({
          date: lixDateOnly(r.date),
          capitalization: lixNumToString(r.capitalization),
          capitalizationH: lixNumToString(r.capitalizationH),
          // changeReason 为文本字段, lixNumToString 对 string 输入亦返 string|null (非空串透传)
          // → 复用同一 vendor 字段归一化。
          changeReason: lixNumToString(r.changeReason),
          // declarationDate 为可空日期列 (缺失落 null 而非空串), 用 lixDateOnlyOrNull。
          declarationDate: lixDateOnlyOrNull(r.declarationDate),
        }),
      )
      .sort((a, b) => a.date.localeCompare(b.date)); // 端口契约: date 升序。
  }
}
