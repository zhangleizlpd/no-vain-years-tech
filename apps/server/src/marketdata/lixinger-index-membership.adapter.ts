import { Injectable } from '@nestjs/common';
import type { IndexMembershipPort } from './index-membership.port.js';
import type { IndexMembershipDto } from './marketdata.types.js';
import { LixingerAdapterBase } from './lixinger-adapter.base.js';
import { toLixinger } from './lixinger-symbol.rules.js';

/**
 * 理杏仁所属指数 adapter (039 US3, INDEX_MEMBERSHIP_PORT live 实现)。
 *
 * POST `/${market}/company/indices` body `{ token, stockCode }` —— `stockCode` **单只** +
 * **无日期** (第 3 形态, 异于其他 4 维的 startDate/endDate 区间): vendor 返当前所属指数快照, 无历史。
 *
 * 响应字段 (p2 prod PoC 实测):
 *   {"areaCode":"hk","stockCode":"1000015","source":"lxri","name":"港股全指"}
 * ⚠️ vendor `stockCode` 字段实为**指数代码** (非个股) → 映射 IndexMembershipDto.indexCode
 * (00700 归属 14 个指数)。摄取侧 live: 覆盖式灌 PG IndexMembership (无-Prisma, 不注 Prisma)。
 */
interface LixingerIndicesRow {
  stockCode?: unknown;
  name?: unknown;
  source?: unknown;
  areaCode?: unknown;
}

@Injectable()
export class LixingerIndexMembershipAdapter
  extends LixingerAdapterBase
  implements IndexMembershipPort
{
  async getIndexMembership(symbol: string): Promise<IndexMembershipDto[]> {
    // 038 seam#1: 路径按 market 段插值 (/cn|/hk); 非 cn/hk 前缀 toLixinger 抛 UnsupportedLixingerMarketError。
    const { market, stockCode } = toLixinger(symbol);

    // 无日期 body (第 3 形态): 只送单数 stockCode。
    const rows = await this.post<LixingerIndicesRow>(`/${market}/company/indices`, { stockCode });

    return (
      rows
        .map(
          (r): IndexMembershipDto => ({
            // vendor `stockCode` 字段 = 指数代码 (非个股) → indexCode。
            indexCode: String(r.stockCode ?? ''),
            name: typeof r.name === 'string' && r.name.length > 0 ? r.name : null,
            source: typeof r.source === 'string' && r.source.length > 0 ? r.source : null,
            areaCode: typeof r.areaCode === 'string' && r.areaCode.length > 0 ? r.areaCode : null,
          }),
        )
        // 端口契约: indexCode 稳定序 (集合无固有序, 排序保覆盖式落库/断言确定性)。
        .sort((a, b) => a.indexCode.localeCompare(b.indexCode))
    );
  }
}
