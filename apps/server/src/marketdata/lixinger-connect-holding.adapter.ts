import { Injectable } from '@nestjs/common';
import type { ConnectHoldingPort } from './connect-holding.port.js';
import type { ConnectHoldingPoint, ConnectHoldingRangeQuery } from './marketdata.types.js';
import { LixingerAdapterBase, lixDateOnly, lixNumToString } from './lixinger-adapter.base.js';
import { toLixinger } from './lixinger-symbol.rules.js';

/**
 * 理杏仁南向持股日频 adapter (039 US1, CONNECT_HOLDING_PORT live 实现)。
 *
 * POST `/${market}/company/mutual-market` body `{ token, stockCode, startDate, endDate? }` ——
 * `stockCode` **单只** (数组 → 400, 同 short-selling; 与 p1 range 批量 `stockCodes` 约定相反)。
 * **不用 `metricsList`** → 无 all-or-nothing 静默 0 行坑。
 *
 * 响应字段 `date/shareholdings` (p2 prod PoC 实测:
 *   {"date":"2025-05-30T00:00:00+08:00","shareholdings":1039052782})。仅 ~600 港股通标的有数据;
 * 非港股通标的 vendor 返 0 行 → 空数组 (executor 零落库不崩)。摄取侧 live: 灌 PG
 * ConnectHoldingDaily (fsType 无关 → 无-Prisma, 不注 Prisma)。
 */
interface LixingerMutualMarketRow {
  date?: unknown;
  shareholdings?: unknown;
}

@Injectable()
export class LixingerConnectHoldingAdapter
  extends LixingerAdapterBase
  implements ConnectHoldingPort
{
  async getConnectHoldingRange(query: ConnectHoldingRangeQuery): Promise<ConnectHoldingPoint[]> {
    // 038 seam#1: 路径按 market 段插值 (/cn|/hk); 非 cn/hk 前缀 toLixinger 抛 UnsupportedLixingerMarketError。
    const { market, stockCode } = toLixinger(query.symbol);
    const body: Record<string, unknown> = { stockCode, startDate: query.from };
    if (query.to) body.endDate = query.to;

    const rows = await this.post<LixingerMutualMarketRow>(`/${market}/company/mutual-market`, body);

    return rows
      .map(
        (r): ConnectHoldingPoint => ({
          date: lixDateOnly(r.date),
          shareholdings: lixNumToString(r.shareholdings),
        }),
      )
      .sort((a, b) => a.date.localeCompare(b.date)); // 端口契约: date 升序。
  }
}
