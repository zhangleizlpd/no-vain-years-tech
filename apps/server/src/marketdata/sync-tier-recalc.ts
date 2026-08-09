import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service.js';

/** 重算结果: 双 updateMany 影响行数 (promoted=升 T0 / demoted=降 T2)。读失败降级 → null。 */
export interface TierRecalcResult {
  promoted: number;
  demoted: number;
}

/**
 * 港股 tier-0 成分**初期 curated 种子** (038 T011, Clarification Q1): HSI/港股通代表性成分
 * (蓝筹 + 房托)。这些标的提级 tier-0 优先落库; 其余在市 hk 标的 tier-2 后置 (仍全量纳入回填,
 * 不缩范围)。
 *
 * DEFERRED-PROBE(P-HSI-CONST): 权威成分来源 = 理杏仁 `hk/index/constituents` (p0 catalog 有),
 * 留 T020/后续 ops 用真端点刷新此清单; 现用最小侵入 curated 种子 (mock 场景可测、零外呼)。
 */
const HK_TIER0_CONSTITUENTS: readonly string[] = [
  '00700', // 腾讯控股
  '09988', // 阿里巴巴
  '03690', // 美团
  '00939', // 建设银行
  '00941', // 中国移动
  '00005', // 汇丰控股
  '01299', // 友邦保险
  '00388', // 香港交易所
  '02318', // 中国平安
  '00883', // 中国海洋石油
  '01810', // 小米集团
  '00823', // 领展房产基金 (REIT)
];

/**
 * syncTier 重算 (018 T001, FR-S01/S02, ADR-0048 Q7-B 直查终态)。
 *
 * fact 维度 executor 前置步骤 (clarify 2026-06-04): 分市场 tier-0 成员制快照 —— cn = 全账号自选
 * 并集 (distinct code); hk = HSI/港股通成分 curated 种子 ∪ hk 自选并集 (038 T011 Clarification Q1)。
 * 命中 → T0(0)、未命中 → T2(2); `syncTier: {not: X}` 过滤保证幂等零行变更 (FR-S01)。港股长尾在市标的
 * 落 T2 后置但**仍全量纳入**回填 (tier 只定优先序、不缩范围)。降级 (FR-S06, D4): 方法内 try/catch 全包 — portfolio 读取/落库异常
 * warn log 后返 null, caller 无感知照常同步 (重算失败 ≠ 维度失败, 不上抛防 executor
 * 顶层 catch 误记 SyncRun=failed)。
 */
@Injectable()
export class SyncTierRecalc {
  private readonly logger = new Logger(SyncTierRecalc.name);

  constructor(private readonly prisma: PrismaService) {}

  async recalcSafely(): Promise<TierRecalcResult | null> {
    try {
      // 每市场的 tier-0 成员集 (038 T011 分市场分层):
      //  - cn: 全账号自选并集 (watchlist) —— 用户关注即高优先 (018 语义不变)。
      //  - hk: HSI/港股通成分 (curated 种子) ∪ hk 自选并集 (Clarification Q1); 长尾在市 → T2 后置。
      const [cnWatch, hkWatch] = await Promise.all([
        this.watchlistCodes('cn'),
        this.watchlistCodes('hk'),
      ]);
      const tier0ByMarket: Record<string, string[]> = {
        cn: cnWatch,
        hk: [...new Set([...HK_TIER0_CONSTITUENTS, ...hkWatch])],
      };

      // 每市场双条件 updateMany, 单事务快照一致 (D3): 无半成品态; tier-0 空 → 第一条天然
      // no-op + 第二条全量回 T2 (state_branch「自选全空」); `{not}` 过滤 = 幂等零行变更 (FR-S01)。
      const ops = Object.entries(tier0ByMarket).flatMap(([market, codes]) => [
        this.prisma.instrument.updateMany({
          where: { market, code: { in: codes }, syncTier: { not: 0 } },
          data: { syncTier: 0 },
        }),
        this.prisma.instrument.updateMany({
          where: { market, code: { notIn: codes }, syncTier: { not: 2 } },
          data: { syncTier: 2 },
        }),
      ]);
      const results = await this.prisma.$transaction(ops);
      // ops 交替 [promote, demote]/市场 → 偶数下标 = promote, 奇数 = demote。
      const promoted = results.reduce((s, r, i) => (i % 2 === 0 ? s + r.count : s), 0);
      const demoted = results.reduce((s, r, i) => (i % 2 === 1 ? s + r.count : s), 0);
      return { promoted, demoted };
    } catch (err) {
      // 业务降级口径 (与 alertIfDegraded 同道 warn/error log, 不新增告警通道 FR-S06)。
      this.logger.warn(`syncTier 重算降级 (沿用现有 tier 照常同步): ${String(err)}`);
      return null;
    }
  }

  /** 某市场全账号自选并集 (distinct code) —— tier-0 成员来源之一。 */
  private async watchlistCodes(market: string): Promise<string[]> {
    // CROSS-CONTEXT-READ: 只读 portfolio watchlist_item 全账号 distinct(market,code) 并集，算 marketdata 自有 syncTier（ADR-0048 Q7-B 终态 2026-06-04）
    const hits = await this.prisma.watchlistItem.findMany({
      where: { market },
      distinct: ['code'],
      select: { code: true },
    });
    return hits.map((h) => h.code);
  }
}
