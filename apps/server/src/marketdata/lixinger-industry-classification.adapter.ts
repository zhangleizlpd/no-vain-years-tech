import { Injectable } from '@nestjs/common';
import type { IndustryClassificationPort } from './industry-classification.port.js';
import type { IndustryClassificationDto } from './marketdata.types.js';
import { LixingerAdapterBase, lixNumToString } from './lixinger-adapter.base.js';
import { toLixinger } from './lixinger-symbol.rules.js';

/**
 * 理杏仁所属行业 adapter (043 US1, INDUSTRY_CLASSIFICATION_PORT live 实现)。
 *
 * POST `/${market}/company/industries` body `{ token, stockCode }` —— `stockCode` **单只** +
 * **无日期** (覆盖式快照形态, 照抄 index_membership; 异于区间维的 startDate/endDate): vendor 返
 * 当前所属行业快照, 无历史。
 *
 * 响应字段 (043 prod 77 probe 实测): 3 级 hsi 层级 3 行/股
 *   {"areaCode":"hk","stockCode":"H70","source":"hsi","name":"..."}   (L1)
 *   {"areaCode":"hk","stockCode":"H7020","source":"hsi","name":"..."}  (L2)
 *   {"areaCode":"hk","stockCode":"H702015","source":"hsi","name":"..."}(L3)
 * ⚠️ vendor `stockCode` 字段实为**行业代码** (非个股) → 映射 IndustryClassificationDto.industryCode。
 * **3 级层级 3 行全出、不去重** (量化按 code 前缀/长度天然派生 L1/L2/L3, plan Decision 3)。摄取侧
 * live: 覆盖式灌 PG IndustryClassification (无-Prisma, 不注 Prisma)。
 */
interface LixingerIndustriesRow {
  stockCode?: unknown;
  name?: unknown;
  source?: unknown;
  areaCode?: unknown;
}

@Injectable()
export class LixingerIndustryClassificationAdapter
  extends LixingerAdapterBase
  implements IndustryClassificationPort
{
  async getIndustryClassification(symbol: string): Promise<IndustryClassificationDto[]> {
    // 038 seam#1: 路径按 market 段插值 (/cn|/hk); 非 cn/hk 前缀 toLixinger 抛 UnsupportedLixingerMarketError。
    const { market, stockCode } = toLixinger(symbol);

    // 无日期 body (覆盖式快照形态): 只送单数 stockCode。
    const rows = await this.post<LixingerIndustriesRow>(`/${market}/company/industries`, {
      stockCode,
    });

    return (
      rows
        .map(
          (r): IndustryClassificationDto => ({
            // vendor `stockCode` 字段 = 行业代码 (非个股) → industryCode (lixNumToString 归一)。
            industryCode: lixNumToString(r.stockCode),
            source: typeof r.source === 'string' && r.source.length > 0 ? r.source : null,
            name: typeof r.name === 'string' && r.name.length > 0 ? r.name : null,
            areaCode: typeof r.areaCode === 'string' && r.areaCode.length > 0 ? r.areaCode : null,
          }),
        )
        // 端口契约: industryCode 稳定序 (集合无固有序, 排序保覆盖式落库/断言确定性; 3 级层级 3 行全保, 不去重)。
        .sort((a, b) => (a.industryCode ?? '').localeCompare(b.industryCode ?? ''))
    );
  }
}
