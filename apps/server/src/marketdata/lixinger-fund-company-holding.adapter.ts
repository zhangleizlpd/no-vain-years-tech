import { Injectable } from '@nestjs/common';
import type { FundCompanyHoldingPort } from './fund-company-holding.port.js';
import type { FundCompanyHoldingDto, FundCompanyHoldingRangeQuery } from './marketdata.types.js';
import { LixingerAdapterBase, lixDateOnly, lixNumToString } from './lixinger-adapter.base.js';
import { toLixinger } from './lixinger-symbol.rules.js';

/**
 * 理杏仁基金公司持股 adapter (039 US2, FUND_COMPANY_HOLDING_PORT live 实现)。
 *
 * POST `/${market}/company/fund-collection-shareholders` body `{ token, stockCode, startDate,
 * endDate? }` —— `stockCode` **单只** (数组 → 400, 同 fund-shareholders; 与 p1 range 批量
 * `stockCodes` 约定相反)。**不用 `metricsList`** → 无 all-or-nothing 静默 0 行坑。
 *
 * 响应字段 (p2 prod PoC 实测):
 *   {"date":"2025-03-31...","marketCap":320952688,"holdings":690600,"name":"中信证券资产管理有限公司",
 *    "fundCollectionCode":"14240000","proportionOfOutstandingSharesA":null}
 * vendor `date` = 报告期 → reportDate。摄取侧 live: 灌 PG FundCompanyHolding (fsType 无关 → 无-Prisma,
 * 不注 Prisma)。
 */
interface LixingerFundCompanyHoldingRow {
  date?: unknown;
  fundCollectionCode?: unknown;
  name?: unknown;
  holdings?: unknown;
  marketCap?: unknown;
}

@Injectable()
export class LixingerFundCompanyHoldingAdapter
  extends LixingerAdapterBase
  implements FundCompanyHoldingPort
{
  async getFundCompanyHoldingRange(
    query: FundCompanyHoldingRangeQuery,
  ): Promise<FundCompanyHoldingDto[]> {
    // 038 seam#1: 路径按 market 段插值 (/cn|/hk); 非 cn/hk 前缀 toLixinger 抛 UnsupportedLixingerMarketError。
    const { market, stockCode } = toLixinger(query.symbol);
    const body: Record<string, unknown> = { stockCode, startDate: query.from };
    if (query.to) body.endDate = query.to;

    const rows = await this.post<LixingerFundCompanyHoldingRow>(
      `/${market}/company/fund-collection-shareholders`,
      body,
    );

    return (
      rows
        .map(
          (r): FundCompanyHoldingDto => ({
            reportDate: lixDateOnly(r.date),
            fundCollectionCode: String(r.fundCollectionCode ?? ''),
            name: typeof r.name === 'string' && r.name.length > 0 ? r.name : null,
            holdings: lixNumToString(r.holdings),
            marketCap: lixNumToString(r.marketCap),
          }),
        )
        // 端口契约: reportDate 升序; 同报告期内按 fundCollectionCode 稳定序 (多基金公司)。
        .sort(
          (a, b) =>
            a.reportDate.localeCompare(b.reportDate) ||
            a.fundCollectionCode.localeCompare(b.fundCollectionCode),
        )
    );
  }
}
