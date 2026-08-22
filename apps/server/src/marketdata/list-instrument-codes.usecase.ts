import { Injectable } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service.js';
import type { InstrumentStatusFilter, QueryableMarket } from './instrument-query.rules.js';
import type { InstrumentCodeListResponse } from './instrument-codes.response.js';

export interface ListInstrumentCodesQuery {
  market: QueryableMarket;
  status: InstrumentStatusFilter;
  /** 可选类型过滤 (stock / etf / index / bond)。缺省不过滤。 */
  type?: string;
}

/**
 * guest 通道枚举口 use case: 列出某市场下的全部 code (ADR-0043 直注 PrismaService, 无
 * repository 层)。
 *
 * **读 PG 注册表, 不打任何 vendor** —— 注册表由 016 的 universe 同步管线灌。
 *
 * 复杂度 **O(m)**, m = 命中行数 (最坏 ~2 万, us 全量)。`uk_instrument_market_code` 是
 * `(market, code)` 复合唯一索引 ⇒ `where market=` 命中索引前缀, 且 `orderBy code asc` 与索引
 * 内序**一致**, PG 直接顺着索引走、**不做额外排序**。`status` / `type` 不在索引里, 是索引扫
 * 之上的行过滤 (选择率极高: 实测 inactive 仅 cn 22 / hk 8 / us 0, 建专用索引没有意义)。
 */
@Injectable()
export class ListInstrumentCodesUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(query: ListInstrumentCodesQuery): Promise<InstrumentCodeListResponse> {
    const { market, status, type } = query;
    const rows = await this.prisma.instrument.findMany({
      where: {
        market,
        // 'all' = 不加 status 谓词。缺省值是 'active', 判定单点在 rules, 这里不再兜底 ——
        // 少一处默认值就少一处会与 rules 漂开的判据。
        ...(status === 'all' ? {} : { status }),
        ...(type === undefined ? {} : { type }),
      },
      select: { code: true },
      orderBy: { code: 'asc' },
    });
    const codes = rows.map((row) => row.code);
    return { market, count: codes.length, codes };
  }
}
