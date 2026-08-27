import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service.js';
import { COMPANY_PROFILE_PORT, type CompanyProfilePort } from './company-profile.port.js';
import { addWritten, emptyStats, type SyncRunStats } from './sync-run.recorder.js';

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
    // #138: 本维度有写路径 ⇒ 起手声明一次 (含下面 missing 为空的早退 —— 那一轮确实跑了、
    // 确实一行没写)。旧口径把 universe/profile 蓄意豁免出 written, 见 sync-universe 同位注释。
    addWritten(stats, 0);

    // 038 T009: 富化范围经 profile 维度 marketScope (seam#2) —— cn + hk。缺行兜底 {cn}。
    const scope = await this.profileMarketScope();

    // 仅缺 fsType 的活跃标的 (已缓存的不重解析 → 零外呼)。按 market 分组 → 逐市场按 fsType 路由。
    //
    // 🚨 **`needSync` 不是可省的筛选项, 是 schema 明文的标的级总闸** —— 那里的原话是
    //    「`false` = 该标的**不进任何同步维度的工作集**」+「粒度 = 标的级一刀切, 该票所有维度
    //    同采 / 同不采」。删掉它会让本维度成为**唯一无视该闸**的维度: 人工关掉采集的票, 别处
    //    都不碰、只有这里还去解析 fsType 并回写库 —— 而且**不会红**。
    //
    // 📌 **它在当前配置下恒真, 故读起来像冗余 —— 别据此删**: 闸的唯一重算方
    //    `AnchorDrivenSyncGate` 只动 us (`ANCHOR_GATED_MARKETS`), 而本维度 `marketScope`
    //    = {cn, hk} ⇒ 两个作用域**不相交**, cn/hk 全走列默认 `true` (2026-08-10 实测
    //    cn 5628 / hk 2782 全真)。保留是为了守上面那条不变量, 不是因为现在有筛选作用。
    //
    // ⚠️ **本维度刻意不走 `factExecutor`** (meta 维度, 自己管自己前置) ⇒ 这里读到的 `needSync`
    //    是**上一次某个 fact 维度跑完时重算留下的值**, 不是本轮刚算的。今天没有后果 (见上,
    //    作用域不相交), 但**若将来把 `us` 加进本维度 `marketScope`, MUST 先解决这个陈旧再动**
    //    —— 那一刻该条件会从「筛掉 0 行」变成「筛掉约 1.9 万行」, 而依据是一份可能过期的闸。
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
          // #138 落库行数 = `resolved.size`。**这是从 port 契约推出来的, 不是本地写的**:
          // 上面的查询条件已把 `lixingerCompanyType: null` 钉死 ⇒ 整批必然全是缓存未命中 ⇒
          // `resolveFsTypes` 对每个解析成功的 code 都会 `updateMany` 回写一行。
          // ⚠️ 该等式的前提就是那个查询条件 —— 若哪天本维度改成也传已缓存的 code, 这个数会
          // 变成高估 (缓存命中不回写), 届时 MUST 让 port 直接返回写入行数。
          addWritten(stats, resolved.size);
          // resolved 命中的算 ok; 未解析出 fsType 的 (vendor 未返/未知类型) 算 skipped。
          for (const code of batch) {
            if (resolved.has(code)) stats.ok++;
            else stats.skipped++;
          }
        } catch (err) {
          stats.failed += batch.length;
          stats.findings.push({
            kind: 'failure',
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
