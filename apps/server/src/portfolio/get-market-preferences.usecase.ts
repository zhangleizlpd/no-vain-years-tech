import { Injectable } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';
import { projectMarkets, type ProjectedMarket } from './portfolio.rules';

export interface MarketPreferencesResult {
  markets: ProjectedMarket[];
}

/**
 * 011 US1 — 读取市场偏好 (intra query, ADR-0043 直注 PrismaService 无 repository)。
 *
 * 纯读 + 投影 (ADR-0046 单行模型): findUnique 该账号单行 → projectMarkets(activeMarkets)。
 * 新账号无行 → projectMarkets(null) 投影默认 {cn:active, hk/us:inactive} (FR-S01)。
 * **GET MUST NOT 写库** (FR-S01/D4): 读侧投影, 不 upsert; 首次写库时机在
 * UpdateMarketPreferenceUseCase 的首 PUT。海外 6 市场由字典恒投影 inactive。
 */
@Injectable()
export class GetMarketPreferencesUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(accountId: bigint): Promise<MarketPreferencesResult> {
    const row = await this.prisma.portfolioPreference.findUnique({ where: { accountId } });
    return { markets: projectMarkets(row?.activeMarkets ?? null) };
  }
}
