import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service.js';

/** 重算结果: 双 updateMany 影响行数 (opened=开闸 / closed=关闸)。读失败降级 → null。 */
export interface AnchorSyncGateResult {
  opened: number;
  closed: number;
}

/**
 * 受锚表驱动的市场集合 —— **仅 us**。
 *
 * 🚨 成对约束: 单一真相源是 `sync-universe.usecase.ts` 新标的 create 分支的
 * `needSync: entry.market !== 'us'` —— 只有 us 走「无锚不采」成员制, cn/hk 是全量语义
 * (列默认 true)。本重算的关闸路径 (`notIn`) 若放到 cn/hk, 会把全部 cn/hk 在市标的一次性
 * 移出工作集 = 直接违反 **SC-007「既有 cn/hk 同步范围零变化」**。两处判据必须同步改。
 */
export const ANCHOR_GATED_MARKETS: readonly string[] = ['us'];

/**
 * canonical `market:code` 拆解 (按**首个**冒号切, code 侧允许含冒号如 `us:BRK:B`)。
 *
 * 🚨 **本 ctx 自持这三行**: 禁 import optionsdesk 的 `parseAnchorTicker` —— ESLint boundaries
 * 的 `from: marketdata` disallow 数组含 `optionsdesk` (T001 注册面), 底座 import 业务 = 方向
 * 铁律反了。ticker 形态本身是**跨 ctx 共享的标识约定**, 不是任一方的业务规则。
 */
export function parseGateTicker(ticker: string): { market: string; code: string } | null {
  const idx = ticker.indexOf(':');
  if (idx <= 0 || idx === ticker.length - 1) return null;
  return { market: ticker.slice(0, idx), code: ticker.slice(idx + 1) };
}

/**
 * 采集闸按锚表重算 `Instrument.needSync` (045 T015, FR-028 / FR-029, plan D7)。
 *
 * fact 维度 executor 的**前置步骤**, 与 {@link import('./sync-tier-recalc.js').SyncTierRecalc}
 * 并列。形态**逐字照抄** `sync-tier-recalc.ts` (plan D7 点名的先例): 跨 ctx `findMany` +
 * `// CROSS-CONTEXT-READ:` 注释 + 每市场双 `updateMany` 单事务快照一致 + 前置条件过滤保幂等
 * + 整方法 try/catch 降级。语义分工与 `syncTier` 正交: **needSync 筛范围、syncTier 只定顺序**。
 *
 * **方向铁律**: marketdata 是底座、optionsdesk 是业务 —— **底座不依赖业务**。故 optionsdesk
 * MUST NOT 被注册进 `SyncDimension` / executor 钩子 (FR-029), 是采集侧**主动拉**锚表 (跨 ctx
 * 只读直查, catalog Q7-B, ADR-0062 已记)。本文件是 045 唯一一条 marketdata → optionsdesk 读边。
 *
 * 🚨 **降级纪律** (FR-029, 照抄 `sync-tier-recalc.ts` 的 D4 降级段): 整方法 try/catch 全包,
 * 锚表读取 / 落库异常一律 `logger.warn` + 返 `null`, **不上抛** —— 上抛会被 executor 顶层
 * catch 记成 `SyncRun = failed`, 用业务侧的一个小故障污染整条采集链的运行状态。且读失败时
 * **一行都不动**: 拿不到锚集就按空集关闸 = 把在采标的全部误停, 期权 EOD **无跨日补救**。
 *
 * 🚨 **绊线 —— `needSync` 是受保护列** (plan 风险 4): schema 注释点名它与 `syncTier` /
 * `lixingerCompanyType` 同属「universe 同步的 update 路径不得覆盖」的列, 而本文件是它的
 * **第二个 (也是唯一另一个) 合法写入点**。⇒ ① 本文件的 `data` payload **只许有 `needSync`
 * 一个 key** (spec 有机械断言守着); ② 若将来 `sync-universe.usecase.ts` 的 update 分支被改成
 * 会写 `needSync`, 每轮 universe 同步都会冲掉这里的重算结果, 且**因表仍在更新而不会立刻显形**
 * —— 改那处前先回来读这条。
 *
 * 🚨 **`excluded` 不参与闸判定** (FR-028 / Guardrail 8): 判据严格是「**有没有锚**」。语义分工
 * = 锚 = 采集意愿、`excluded` = 交易意愿; 要彻底停采只能**删锚**。决定性理由 = 期权 EOD 无
 * 跨日补救, 误停采一天就是永久断层, 而多采一只已排除的标的只是几次 API 调用。实现级保证 =
 * 读锚表只 `select: { ticker }`, `excluded` 根本不进查询。
 *
 * **时序** (SC-003): 建锚 → 下一轮 cron 的 fact 前置步骤重算 → 纳入工作集, 全程零代码改动、
 * 零人工 SQL。**不是**建锚即时生效 —— 即时生效要 optionsdesk 跨 ctx **写** marketdata 的表,
 * 护城河已禁 (`check-server-moat.ts` 的 `moat-write`)。
 */
@Injectable()
export class AnchorDrivenSyncGate {
  private readonly logger = new Logger(AnchorDrivenSyncGate.name);

  constructor(private readonly prisma: PrismaService) {}

  async recalcSafely(): Promise<AnchorSyncGateResult | null> {
    try {
      const codesByMarket = await this.anchoredCodesByMarket();

      // 每市场双条件 updateMany, 单事务快照一致 (照抄 sync-tier-recalc.ts): 无半成品态;
      // 锚集为空 → 第一条天然 no-op (`in: []`) + 第二条全量关闸 (`notIn: []` 匹配全行);
      // `needSync` 前置过滤 = 幂等零行变更 (等价 tier 侧的 `syncTier: { not: X }`)。
      const ops = ANCHOR_GATED_MARKETS.flatMap((market) => {
        const codes = codesByMarket.get(market) ?? [];
        return [
          this.prisma.instrument.updateMany({
            where: { market, code: { in: codes }, needSync: false },
            data: { needSync: true },
          }),
          this.prisma.instrument.updateMany({
            where: { market, code: { notIn: codes }, needSync: true },
            data: { needSync: false },
          }),
        ];
      });
      const results = await this.prisma.$transaction(ops);
      // ops 交替 [open, close]/市场 → 偶数下标 = 开闸, 奇数 = 关闸 (同 tier 侧计数法)。
      const opened = results.reduce((s, r, i) => (i % 2 === 0 ? s + r.count : s), 0);
      const closed = results.reduce((s, r, i) => (i % 2 === 1 ? s + r.count : s), 0);
      return { opened, closed };
    } catch (err) {
      // 业务降级口径 (与 syncTier 重算同道 warn log, 不新增告警通道)。
      this.logger.warn(`采集闸按锚表重算降级 (沿用现有 needSync 照常同步): ${String(err)}`);
      return null;
    }
  }

  /** 锚表全量 ticker → 按市场分组的 code 集 (仅保留受闸市场)。 */
  private async anchoredCodesByMarket(): Promise<Map<string, string[]>> {
    // CROSS-CONTEXT-READ: 只读 optionsdesk.anchor 全量 ticker (catalog Q7-B 只读逃生口,
    // ADR-0062 已记), 算 marketdata 自有的 needSync 采集闸。零写、零 @Inject() 对方 use case;
    // 只取 ticker 一列 —— excluded MUST NOT 参与闸判定 (FR-028)。
    const rows = await this.prisma.anchor.findMany({ select: { ticker: true } });

    const byMarket = new Map<string, string[]>();
    for (const { ticker } of rows) {
      const parsed = parseGateTicker(ticker);
      if (parsed === null || !ANCHOR_GATED_MARKETS.includes(parsed.market)) continue;
      const codes = byMarket.get(parsed.market);
      if (codes) codes.push(parsed.code);
      else byMarket.set(parsed.market, [parsed.code]);
    }
    return byMarket;
  }
}
