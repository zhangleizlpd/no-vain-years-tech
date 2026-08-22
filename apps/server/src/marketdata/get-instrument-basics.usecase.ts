import { Injectable } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service.js';
import type { QueryableMarket } from './instrument-query.rules.js';
import type {
  InstrumentBasicItem,
  InstrumentBasicsResponse,
} from './instrument-basics.response.js';

export interface GetInstrumentBasicsQuery {
  market: QueryableMarket;
  /** 已去空段、保序去重、过完字符集与上限的 code 列表 (判定单点在 rules)。 */
  codes: string[];
}

/** 同 `get-instrument-detail.usecase.ts` 的同名局部工具 —— `@db.Date` 读回来是 UTC 零点的
 *  `Date`, 必须走 `toISOString()` 取日; 用本地时区格式化会整体差一天**且不报错**。 */
const nullableDateOnly = (d: Date | null): string | null =>
  d === null ? null : d.toISOString().slice(0, 10);

/**
 * guest 通道批量口 use case: 按 code 批量取标的基础信息 (ADR-0043 直注 PrismaService)。
 *
 * 复杂度 **O(k log n)**, k = 请求 code 数 (≤500)。`code IN (...)` 落在
 * `uk_instrument_market_code` 上, 每个 code 一次索引点查。
 *
 * 🚨 **精确匹配, 不归一** (判据与理由在 `instrument-query.rules.ts` 顶部)。未命中不报错、
 * 也不静默丢弃 —— 进 `missing[]`。「查无此 code」与「查到了但字段为空」在响应里必须可区分,
 * 否则 us 那批恒 null 的 `listDate` 会被读成「这只票不存在」。
 */
@Injectable()
export class GetInstrumentBasicsUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(query: GetInstrumentBasicsQuery): Promise<InstrumentBasicsResponse> {
    const { market, codes } = query;
    const rows = await this.prisma.instrument.findMany({
      where: { market, code: { in: codes } },
      select: {
        market: true,
        code: true,
        name: true,
        type: true,
        currency: true,
        status: true,
        listingStatus: true,
        listDate: true,
        delistDate: true,
      },
      orderBy: { code: 'asc' },
    });

    const found = new Set(rows.map((row) => row.code));
    const items = rows.map(
      (row): InstrumentBasicItem => ({
        symbol: `${row.market}:${row.code}`,
        market: row.market,
        code: row.code,
        name: row.name,
        type: row.type,
        currency: row.currency,
        status: row.status,
        listingStatus: row.listingStatus,
        listDate: nullableDateOnly(row.listDate),
        delistDate: nullableDateOnly(row.delistDate),
      }),
    );

    // 按**请求顺序**回显未命中 —— 调方对得上自己发出去的那一批 (rules 已保序去重)。
    return { market, items, missing: codes.filter((code) => !found.has(code)) };
  }
}
