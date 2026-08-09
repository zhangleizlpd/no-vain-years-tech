import { Injectable } from '@nestjs/common';
import type { FundHoldingPort } from './fund-holding.port.js';
import type { FundHoldingDto, FundHoldingRangeQuery } from './marketdata.types.js';
import {
  LixingerAdapterBase,
  lixDateOnly,
  lixDateOnlyOrNull,
  lixNumToString,
} from './lixinger-adapter.base.js';
import { toLixinger } from './lixinger-symbol.rules.js';

/**
 * 理杏仁公募基金持股 adapter (039 US2, FUND_HOLDING_PORT live 实现)。
 *
 * POST `/${market}/company/fund-shareholders` body `{ token, stockCode, startDate, endDate? }` ——
 * `stockCode` **单只** (数组 `stockCodes` → HTTP 400, p2 探查报告实测; 与 p1 fundamental/fs range
 * 批量 `stockCodes` 约定**相反** → 每端点单独确认, 不套用)。**不用 `metricsList`** → 无 p1 #670
 * all-or-nothing 静默 0 行坑。
 *
 * 响应字段 (p2 prod PoC 实测):
 *   {"date":"2025-03-31...","holdings":24158500,"marketCap":11080211711,"netValueRatio":0.2994,
 *    "marketCapRank":1,"declarationDate":"2025-04-22...","fundCode":"513050","name":"...",
 *    "proportionOfOutstandingSharesA":null}
 * vendor `date` = 报告期 → reportDate; `proportionOfOutstandingSharesA` 名带 A (hk 返 null) 存 null
 * 不因命名丢弃 (spec 字段命名残留)。摄取侧 live: 灌 PG FundHolding (fsType 无关 → 无-Prisma, 不注 Prisma)。
 */
interface LixingerFundHoldingRow {
  date?: unknown;
  fundCode?: unknown;
  name?: unknown;
  holdings?: unknown;
  marketCap?: unknown;
  netValueRatio?: unknown;
  marketCapRank?: unknown;
  declarationDate?: unknown;
  proportionOfOutstandingSharesA?: unknown;
}

@Injectable()
export class LixingerFundHoldingAdapter extends LixingerAdapterBase implements FundHoldingPort {
  async getFundHoldingRange(query: FundHoldingRangeQuery): Promise<FundHoldingDto[]> {
    // 038 seam#1: 路径按 market 段插值 (/cn|/hk); 非 cn/hk 前缀 toLixinger 抛 UnsupportedLixingerMarketError。
    const { market, stockCode } = toLixinger(query.symbol);
    const body: Record<string, unknown> = { stockCode, startDate: query.from };
    if (query.to) body.endDate = query.to;

    const rows = await this.post<LixingerFundHoldingRow>(
      `/${market}/company/fund-shareholders`,
      body,
    );

    return (
      rows
        .map(
          (r): FundHoldingDto => ({
            reportDate: lixDateOnly(r.date),
            fundCode: String(r.fundCode ?? ''),
            name: lixStrOrNull(r.name),
            holdings: lixNumToString(r.holdings),
            marketCap: lixNumToString(r.marketCap),
            netValueRatio: lixNumToString(r.netValueRatio),
            marketCapRank: lixIntOrNull(r.marketCapRank),
            declarationDate: lixDateOnlyOrNull(r.declarationDate),
            proportionOutstandingSharesA: lixNumToString(r.proportionOfOutstandingSharesA),
          }),
        )
        // 端口契约: reportDate 升序; 同报告期内按 fundCode 稳定序 (多基金)。
        .sort(
          (a, b) =>
            a.reportDate.localeCompare(b.reportDate) || a.fundCode.localeCompare(b.fundCode),
        )
    );
  }
}

/** 理杏仁整数序数字段 → number (Prisma Int? 列; null/非有限数 → null)。 */
function lixIntOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}

/** 理杏仁字符串字段 → string; null/undefined/空串 → null。 */
function lixStrOrNull(v: unknown): string | null {
  if (typeof v === 'string' && v.length > 0) return v;
  return null;
}
