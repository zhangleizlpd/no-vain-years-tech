import { Injectable } from '@nestjs/common';
import type { ShortSellingPort } from './short-selling.port.js';
import type { ShortSellingPoint, ShortSellingRangeQuery } from './marketdata.types.js';
import { LixingerAdapterBase, lixDateOnly, lixNumToString } from './lixinger-adapter.base.js';
import { toLixinger } from './lixinger-symbol.rules.js';

/**
 * 理杏仁做空日频 adapter (039 US1, SHORT_SELLING_PORT live 实现)。
 *
 * POST `/${market}/company/short-selling` body `{ token, stockCode, startDate, endDate? }` ——
 * `stockCode` **单只** (数组 `stockCodes` → HTTP 400, p2 探查报告 attempt 0/1 实测坐实; 与 p1
 * fundamental/fs range 的批量 `stockCodes` 约定**相反** → 每端点单独确认, 不套用)。**不用
 * `metricsList`** (返回固定字段) → 无 p1 #670 all-or-nothing 静默 0 行坑。
 *
 * 响应字段 `date/shares/amount` (p2 prod PoC 实测:
 *   {"date":"2025-05-30T00:00:00+08:00","shares":1831500,"amount":915201080})。
 * 摄取侧 live: backfill/delta 灌 PG ShortSellingDaily (fsType 无关 → 无-Prisma, 不注 Prisma)。
 */
interface LixingerShortSellingRow {
  date?: unknown;
  shares?: unknown;
  amount?: unknown;
}

@Injectable()
export class LixingerShortSellingAdapter extends LixingerAdapterBase implements ShortSellingPort {
  async getShortSellingRange(query: ShortSellingRangeQuery): Promise<ShortSellingPoint[]> {
    // 038 seam#1: 路径按 market 段插值 (/cn|/hk); 非 cn/hk 前缀 toLixinger 抛 UnsupportedLixingerMarketError。
    const { market, stockCode } = toLixinger(query.symbol);
    const body: Record<string, unknown> = { stockCode, startDate: query.from };
    if (query.to) body.endDate = query.to;

    const rows = await this.post<LixingerShortSellingRow>(`/${market}/company/short-selling`, body);

    return rows
      .map(
        (r): ShortSellingPoint => ({
          date: lixDateOnly(r.date),
          shares: lixNumToString(r.shares),
          amount: lixNumToString(r.amount),
        }),
      )
      .sort((a, b) => a.date.localeCompare(b.date)); // 端口契约: date 升序。
  }
}
