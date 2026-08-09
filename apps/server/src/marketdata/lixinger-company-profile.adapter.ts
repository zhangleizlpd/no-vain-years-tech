import { Injectable } from '@nestjs/common';
import type { PrismaService } from '../security/prisma.service.js';
import type { CompanyProfilePort } from './company-profile.port.js';
import { LixingerAdapterBase } from './lixinger-adapter.base.js';
import type { VendorHttpClient } from './vendor-http-client.js';

/**
 * 理杏仁公司画像 adapter (016 T010, COMPANY_PROFILE_PORT live 实现, FR-S06)。
 *
 * 薄封装 015 `LixingerAdapterBase.resolveFsTypes` (protected) —— 它已实现「先读
 * `Instrument.lixingerCompanyType` 缓存; 缺失批量 POST `/cn/company` 取 `fs_type` 并
 * `updateMany` 回写缓存」。本 adapter 只是把这条既有路径暴露成独立 capability, 让
 * profile 维度能在 fundamental **之前**低频预热 fsType 缓存 (fundamental adapter 内部
 * 也会兜底解析, 但每夜重解析浪费配额 → profile 步预热)。
 */
@Injectable()
export class LixingerCompanyProfileAdapter
  extends LixingerAdapterBase
  implements CompanyProfilePort
{
  constructor(
    http: VendorHttpClient,
    token: string,
    baseUrl: string,
    // PrismaService 经 SecurityModule export 复用 (platform infra, ADR-0041 无跨 ctx 注释);
    // 仅读写 marketdata 自己的 instrument 表 (intra, moat 已登记)。
    private readonly prisma: PrismaService,
  ) {
    super(http, token, baseUrl);
  }

  /**
   * 复用 base 的缓存-then-取 `/{market}/company` 路径 (副作用回写 lixingerCompanyType)。
   * 038 T009: market 段参数化 —— hk profile 富化按 hk fsType 值域 (含房托 `reit`) 路由 /hk/company。
   */
  async resolveCompanyTypes(market: string, codes: string[]): Promise<Map<string, string>> {
    return this.resolveFsTypes(this.prisma, market, codes);
  }
}
