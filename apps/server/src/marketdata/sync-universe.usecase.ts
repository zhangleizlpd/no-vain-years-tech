import { Inject, Injectable } from '@nestjs/common';
import { pinyin } from 'pinyin-pro';
import { PrismaService } from '../security/prisma.service.js';
import {
  INSTRUMENT_UNIVERSE_PORT,
  type InstrumentUniversePort,
} from './instrument-universe.port.js';
import type { UniverseEntry } from './marketdata.types.js';
import { emptyStats, type SyncRunStats } from './sync-run.recorder.js';

/**
 * universe 同步 use case (016 T008, FR-S01/S03 / US3)。
 *
 * 维度序首步: enumerate 全 A 股 → 过滤 SyncBlacklist → pinyin-pro 填充 abbr/full →
 * upsert Instrument on (market, code)。新标的 insert (pinyin + syncTier 落 schema 默认 2);
 * 既有标的 update **仅** name/status/pinyin, **不覆盖** syncTier / lixingerCompanyType /
 * type / currency (FR-S03: 同步层不重置下游富化/分级缓存)。
 *
 * **隔离**: 逐标的 try/catch, 单标坏不整体失败 (照搬 anonymize 范式); 计数累加 SyncRunStats
 * 由调用方 (DimensionExecutorRegistry) 落 SyncRun 行。本 use case 只返统计,
 * 不自管 SyncRun 生命周期。
 */
@Injectable()
export class SyncUniverseUseCase {
  constructor(
    @Inject(INSTRUMENT_UNIVERSE_PORT) private readonly universe: InstrumentUniversePort,
    private readonly prisma: PrismaService,
  ) {}

  async run(): Promise<SyncRunStats> {
    const stats = emptyStats();
    const entries = await this.universe.enumerate(await this.universeMarketScope());
    stats.scanned = entries.length;

    const blacklist = await this.loadBlacklist();

    for (const entry of entries) {
      const key = `${entry.market}:${entry.code}`;
      if (blacklist.has(key)) {
        stats.skipped++;
        continue;
      }
      try {
        await this.upsert(entry);
        stats.ok++;
      } catch (err) {
        stats.failed++;
        stats.failedTargets.push({ symbol: key, step: 'universe', error: String(err) });
      }
    }
    return stats;
  }

  /**
   * 枚举市场范围 = 本 `universe` 维度的 marketScope (S2-T2/T3: 加 us 即开 us 枚举总开关;
   * per-market fallback 由 UniverseFallbackChainAdapter 承担 — cn/hk 理杏仁 / us 东财)。
   * 缺行 / 空 scope → 回退 `['cn']` 兜底不空跑 (universe seed 恒存在, 防御性)。
   */
  private async universeMarketScope(): Promise<string[]> {
    const dim = await this.prisma.syncDimension.findUnique({
      where: { dimensionKey: 'universe' },
      select: { marketScope: true },
    });
    const scope = dim?.marketScope ?? [];
    return scope.length > 0 ? scope : ['cn'];
  }

  /** SyncBlacklist 全表 → `market:code` Set (黑名单规模小, 全量加载)。 */
  private async loadBlacklist(): Promise<Set<string>> {
    const rows = await this.prisma.syncBlacklist.findMany({ select: { market: true, code: true } });
    return new Set(rows.map((r) => `${r.market}:${r.code}`));
  }

  /**
   * upsert: insert 新标的 (pinyin + 默认值); update 仅 name/status/listingStatus/listDate/pinyin
   * (护 syncTier/fsType/needSync)。`status`/`listingStatus`/`listDate` 由 listingStatus-aware 源 (理杏仁)
   * 提供; 无状态概念的源 (东财 clist) 缺省 → status 默认 'active'、listingStatus/listDate 存 null
   * (ADR-0047 Amendment 2026-06-03)。
   */
  private async upsert(entry: UniverseEntry): Promise<void> {
    const abbr = toPinyin(entry.name, { pattern: 'first' });
    const full = toPinyin(entry.name);
    const status = entry.status ?? 'active'; // 无状态源默认 active (东财 clist = listed-only)
    const listingStatus = entry.listingStatus ?? null;
    const listDate = entry.listDate ? new Date(`${entry.listDate}T00:00:00Z`) : null;
    await this.prisma.instrument.upsert({
      where: { market_code: { market: entry.market, code: entry.code } },
      create: {
        market: entry.market,
        code: entry.code,
        name: entry.name,
        type: 'stock', // universe = clist A 股板块, 均个股; ETF/index 分类由专源富化
        currency: currencyForMarket(entry.market, entry.code), // 038 T004: 按 market + code (B 股例外)
        status,
        listingStatus,
        listDate,
        pinyinAbbr: abbr,
        pinyinFull: full,
        // 采集闸 (成员制): us 新标的默认**不采** (无锚不采) —— 仍全量入库供搜索 / 发现候选;
        // 其余市场默认采 (cn/hk 全量语义不变)。DB 列默认值无法按市场区分, 故策略落在此**单一
        // 写入点**而非各 universe adapter —— 换源 (东财 → 富途) 后自动继续成立。
        needSync: entry.market !== 'us',
        // syncTier 走 schema @default(2); lixingerCompanyType 留 null 待 profile 富化 (T010)
      },
      update: {
        name: entry.name,
        status,
        listingStatus,
        listDate,
        pinyinAbbr: abbr,
        pinyinFull: full,
        // 不写 syncTier / lixingerCompanyType / type / currency / needSync (FR-S03 护下游缓存;
        // needSync 若被覆盖 → 每轮 universe 同步把人工开启的 us 标的重置回不采, 且因表仍在更新
        // 而不会立刻显形)
      },
    });
  }
}

/**
 * 标的计价币种 (038 T004 / S2-T3): 港股 HKD / 美股 USD / 其余 (A 股) CNY。新市场接入时在此扩。
 *
 * 🚨 **cn 不能只看 market** —— 沪深两市的 B 股虽挂在 cn, 却以外币交易 (深市 200xxx 港币 /
 *    沪市 900xxx 美元), 而库里 `DailyBar` 存的价格就是那个本币。判据不是推测: 沪市 B 股实测
 *    收盘 900902=0.163 / 900903=0.185, 而沪市任何股票都不可能以 ¥0.16 交易 (低于 ¥1 即触及
 *    退市) ⇒ 只能是 USD 计价。
 *
 * 🚨 **标错不会报错, 只会让复权因子静默失真**: 派息 payload 的币种 (HKD/USD, 是对的) 与本值
 *    不符时, `buildFactorEventTerms` 的币种守卫会把派息置 null (刻意不做汇率换算), 条款法于是
 *    退化成「无此事件」f=1, 与见证法必然分歧 → 该除权日落 `needs_review` + 因子 1
 *    ⇒ **那只票除权日之前的整段历史都没被复权**。2026-08 实测 13 只 B 股全中此坑。
 *
 * `code` 刻意**必填**而非可选: 给默认值等于允许调用方漏传后静默回落 CNY —— 那正是本 bug 的形状。
 */
export function currencyForMarket(market: string, code: string): string {
  if (market === 'hk') return 'HKD';
  if (market === 'us') return 'USD';
  if (market === 'cn') {
    if (code.startsWith('200')) return 'HKD'; // 深市 B 股
    if (code.startsWith('900')) return 'USD'; // 沪市 B 股
  }
  return 'CNY';
}

/** name → 拼音 (无音调, 无分隔)。空/纯非中文映射空串 → null (列 nullable)。 */
function toPinyin(name: string, opts?: { pattern: 'first' }): string | null {
  const out = pinyin(name, { ...opts, toneType: 'none', separator: '' }).trim();
  return out.length > 0 ? out : null;
}
