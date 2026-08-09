import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service.js';
import { COMPANY_PROFILE_PORT, type CompanyProfilePort } from './company-profile.port.js';
import { emptyStats, type SyncRunStats } from './sync-run.recorder.js';

/** 单批解析的 stockCode 上限 (理杏仁 /cn/company 批量约束保守值; 超量分批)。 */
const PROFILE_BATCH_SIZE = 100;

/**
 * profile 富化 use case (016 T010, FR-S06 / US5 维度序第二步)。
 *
 * **低频缓存预热**: 找出 `lixingerCompanyType` 仍为 null 的活跃标的 (范围 = profile 维度
 * marketScope, cn+hk) → 按 market 分组批量经 `COMPANY_PROFILE_PORT` 解析 fsType (副作用回写缓存)。
 * fsType 极少变, 故只对缺失项跑 (已缓存的标的不在查询集 → 零外呼)。后续 fundamental 步按缓存的
 * fsType 路由端点 (038 T009: hk 含房托 `reit`)。
 *
 * **隔离**: 逐批 try/catch, 单批坏 (vendor 错) 不阻塞其余批; 计数累加 SyncRunStats 由
 * 调用方 (DimensionExecutorRegistry) 落 SyncRun (与 sync-universe 同范式, 不自管 SyncRun 生命周期)。
 */
@Injectable()
export class SyncProfileUseCase {
  constructor(
    @Inject(COMPANY_PROFILE_PORT) private readonly profile: CompanyProfilePort,
    private readonly prisma: PrismaService,
  ) {}

  async run(): Promise<SyncRunStats> {
    const stats = emptyStats();

    // 038 T009: 富化范围经 profile 维度 marketScope (seam#2) —— cn + hk。缺行兜底 {cn}。
    const scope = await this.profileMarketScope();

    // 仅缺 fsType 的活跃标的 (已缓存的不重解析 → 零外呼)。按 market 分组 → 逐市场按 fsType 路由。
    const missing = await this.prisma.instrument.findMany({
      where: { market: { in: scope }, status: 'active', needSync: true, lixingerCompanyType: null },
      select: { market: true, code: true },
      orderBy: [{ market: 'asc' }, { code: 'asc' }],
    });
    stats.scanned = missing.length;
    if (missing.length === 0) return stats;

    const byMarket = new Map<string, string[]>();
    for (const r of missing) {
      const list = byMarket.get(r.market) ?? [];
      list.push(r.code);
      byMarket.set(r.market, list);
    }

    for (const [market, codes] of byMarket) {
      for (let i = 0; i < codes.length; i += PROFILE_BATCH_SIZE) {
        const batch = codes.slice(i, i + PROFILE_BATCH_SIZE);
        try {
          const resolved = await this.profile.resolveCompanyTypes(market, batch);
          // resolved 命中的算 ok; 未解析出 fsType 的 (vendor 未返/未知类型) 算 skipped。
          for (const code of batch) {
            if (resolved.has(code)) stats.ok++;
            else stats.skipped++;
          }
        } catch (err) {
          stats.failed += batch.length;
          stats.failedTargets.push({
            symbol: `${market}:${batch[0]}..${batch.length}`,
            step: 'profile',
            error: String(err),
          });
        }
      }
    }
    return stats;
  }

  /** profile 维度 marketScope (038 seam#2); 维度行缺失兜底 {cn} (不因 seed 残缺漏富化)。 */
  private async profileMarketScope(): Promise<string[]> {
    const dim = await this.prisma.syncDimension.findUnique({
      where: { dimensionKey: 'profile' },
      select: { marketScope: true },
    });
    return dim && dim.marketScope.length > 0 ? dim.marketScope : ['cn'];
  }
}
