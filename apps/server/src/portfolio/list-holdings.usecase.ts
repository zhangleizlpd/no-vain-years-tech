import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../security/prisma.service';
import type {
  ClosedPositionItem,
  HoldingItem,
  HoldingsListResponse,
} from './holdings-list.response';

/** Prisma Decimal → wire string (禁 Float; decimal.js toString 去尾零); null 穿透。 */
const dec = (v: Prisma.Decimal | null): string | null => (v === null ? null : v.toString());

/** `@db.Date` 列 → 'YYYY-MM-DD' (UTC 零点 Date 取日)。 */
const dateStr = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * 025 US2 EP2 — 持仓列表 (intra query, ADR-0043 直注 PrismaService 无 repository)。
 *
 * holding (weightPct desc, null 殿后) + closed_position (closeDate desc) 双查询拼
 * `{ asOf, current[], closed[] }`; asOf 取 holding 首行 (表内同批一致, plan D6),
 * 无持仓行 → null + current 空 (closed 独立查出)。行情值不经本 UC (ADR-0048,
 * mobile quote client-merge); quotable=false 行照常返回 (mobile 降级展示)。
 */
@Injectable()
export class ListHoldingsUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(accountId: bigint): Promise<HoldingsListResponse> {
    const [holdings, closed] = await Promise.all([
      this.prisma.holding.findMany({
        where: { accountId },
        orderBy: [{ weightPct: { sort: 'desc', nulls: 'last' } }, { code: 'asc' }],
      }),
      this.prisma.closedPosition.findMany({
        where: { accountId },
        orderBy: [{ closeDate: 'desc' }, { id: 'asc' }],
      }),
    ]);

    const current: HoldingItem[] = holdings.map((r) => ({
      id: r.id.toString(),
      market: r.market,
      code: r.code,
      name: r.name,
      qty: r.qty.toString(),
      unitCost: r.unitCost.toString(),
      weightPct: dec(r.weightPct),
      holdDays: r.holdDays,
      cumPnl: dec(r.cumPnl),
      cumPnlPct: dec(r.cumPnlPct),
      quotable: r.quotable,
    }));

    const closedItems: ClosedPositionItem[] = closed.map((r) => ({
      id: r.id.toString(),
      market: r.market,
      code: r.code,
      name: r.name,
      openDate: dateStr(r.openDate),
      closeDate: dateStr(r.closeDate),
      buyAvg: r.buyAvg.toString(),
      sellAvg: r.sellAvg.toString(),
      totalPnl: r.totalPnl.toString(),
      totalPnlPct: dec(r.totalPnlPct),
      fee: dec(r.fee),
      indexPct: dec(r.indexPct),
      vsIndexPct: dec(r.vsIndexPct),
    }));

    const first = holdings[0];
    return {
      asOf: first ? dateStr(first.asOf) : null,
      current,
      closed: closedItems,
    };
  }
}
