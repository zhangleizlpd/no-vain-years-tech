import { Injectable } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';
import type { TradeCategory } from './holdings-import.rules';
import type { TradeItem, TradeListResponse } from './trade-list.response';

/**
 * 025 US3 EP3 — 标的交易流水 (intra query, ADR-0043 直注 PrismaService 无 repository)。
 *
 * 等值 (accountId, market, code) 查 trade_record (覆盖索引
 * ix_traderecord_account_market_code_date), `ORDER BY tradeDate DESC,
 * tradeTime DESC NULLS LAST` (同日多笔按时间倒序, 无时间行殿后)。未交易标的 →
 * 空 items (200 非 404); 资金行 (code null) 等值查询天然不命中。
 */
@Injectable()
export class ListTradesUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(accountId: bigint, market: string, code: string): Promise<TradeListResponse> {
    const rows = await this.prisma.tradeRecord.findMany({
      where: { accountId, market, code },
      orderBy: [{ tradeDate: 'desc' }, { tradeTime: { sort: 'desc', nulls: 'last' } }],
    });

    const items: TradeItem[] = rows.map((r) => ({
      id: r.id.toString(),
      market,
      code,
      name: r.name,
      category: r.category as TradeCategory,
      tradeDate: r.tradeDate.toISOString().slice(0, 10),
      tradeTime: r.tradeTime,
      qty: r.qty === null ? null : r.qty.toString(),
      price: r.price === null ? null : r.price.toString(),
      amount: r.amount.toString(),
      turnover: r.turnover === null ? null : r.turnover.toString(),
      fee: r.fee === null ? null : r.fee.toString(),
      note: r.note,
    }));
    return { items };
  }
}
