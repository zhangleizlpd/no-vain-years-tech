import { Injectable } from '@nestjs/common';
import type { BuybackPort } from './buyback.port.js';
import type { BuybackDto, BuybackRangeQuery } from './marketdata.types.js';
import { LixingerAdapterBase, lixDateOnly, lixNumToString } from './lixinger-adapter.base.js';
import { toLixinger } from './lixinger-symbol.rules.js';

/**
 * 理杏仁回购事件 adapter (041 US1, BUYBACK_PORT live 实现)。
 *
 * POST `/${market}/company/repurchase` body `{ token, stockCode, startDate, endDate? }` ——
 * `stockCode` **单只** (数组 `stockCodes` → HTTP 400, 同 039 short-selling 单数契约)。**不用
 * `metricsList`** (返回固定丰富字段) → 无 p1 #670 all-or-nothing 静默 0 行坑。
 *
 * 响应字段 (p3 探查报告实测 hk:00700):
 *   {"_id":"68f6e365...","date":"2024-12-31...","num":1370000,"highestPrice":421.4,"lowestPrice":416,
 *    "totalPaid":574035480,"avgPrice":419.004,"methodOfPurchase":"exchange",
 *    "totalSharesForCancellation":1370000,"totalSharesForTreasury":0,
 *    "ratioPurchasedSinceResolution":0.02445,"currency":"HKD","boardType":"main",...}。
 * 金融数值跨边界一律 string|null (FR-S08); executor 落库时 BigInt/Decimal 列各自转换。
 * **C1 扩键** (T018 真调实证同日多笔真实存在: 汇丰 00005 同日两市场回购 GBP/turquoise + HKD/exchange):
 * `_id` (vendor 源头稳定唯一 24 位 hex, 全非空) → `vendorEventId` 进自然键 (instrumentId, date, vendorEventId),
 * 防单纯 (instrumentId, date) 的 skipDuplicates 丢真行; 同 `_id` 重同步 → 折叠幂等 (Kafka 幂等键范式)。
 * 摄取侧 live: backfill/delta 灌 PG BuybackEvent (无 fsType → 无-Prisma, 不注 Prisma)。
 */
interface LixingerRepurchaseRow {
  _id?: unknown;
  date?: unknown;
  num?: unknown;
  highestPrice?: unknown;
  lowestPrice?: unknown;
  avgPrice?: unknown;
  totalPaid?: unknown;
  totalSharesForCancellation?: unknown;
  totalSharesForTreasury?: unknown;
  ratioPurchasedSinceResolution?: unknown;
  methodOfPurchase?: unknown;
  currency?: unknown;
  boardType?: unknown;
}

@Injectable()
export class LixingerBuybackAdapter extends LixingerAdapterBase implements BuybackPort {
  async getBuybackRange(query: BuybackRangeQuery): Promise<BuybackDto[]> {
    // 038 seam#1: 路径按 market 段插值 (/cn|/hk); 非 cn/hk 前缀 toLixinger 抛 UnsupportedLixingerMarketError。
    const { market, stockCode } = toLixinger(query.symbol);
    const body: Record<string, unknown> = { stockCode, startDate: query.from };
    if (query.to) body.endDate = query.to;

    const rows = await this.post<LixingerRepurchaseRow>(`/${market}/company/repurchase`, body);

    return rows
      .map(
        (r): BuybackDto => ({
          date: lixDateOnly(r.date),
          // vendor `_id` 源头稳定唯一 id (24 位 hex, 全非空) → 自然键判别字段, 防同日多笔折叠丢行 (C1)。
          vendorEventId: String(r._id),
          num: lixNumToString(r.num),
          highestPrice: lixNumToString(r.highestPrice),
          lowestPrice: lixNumToString(r.lowestPrice),
          avgPrice: lixNumToString(r.avgPrice),
          totalPaid: lixNumToString(r.totalPaid),
          totalSharesForCancellation: lixNumToString(r.totalSharesForCancellation),
          totalSharesForTreasury: lixNumToString(r.totalSharesForTreasury),
          ratioPurchasedSinceResolution: lixNumToString(r.ratioPurchasedSinceResolution),
          // methodOfPurchase/currency/boardType 为文本字段, lixNumToString 对 string 输入
          // 亦返 string|null (非空串透传) → 复用同一 vendor 字段归一化。
          methodOfPurchase: lixNumToString(r.methodOfPurchase),
          currency: lixNumToString(r.currency),
          boardType: lixNumToString(r.boardType),
        }),
      )
      .sort((a, b) => a.date.localeCompare(b.date)); // 端口契约: date 升序。
  }
}
