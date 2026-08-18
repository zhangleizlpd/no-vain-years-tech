import type { TradingCalendarPort } from '../marketdata/trading-calendar.port';
import { parseAnchorTicker } from './anchor.rules';

/**
 * 046 FR-020 —— 「最近一个已收盘交易日」的取数侧 (判据本身在 `freshness-tier.ts`)。
 *
 * ## 🚨 062 T010 起走 **`TRADING_CALENDAR_PORT` 注入**, 不再 `PrismaService` 直查
 *
 * 本文件原先的头注释写着「**不合并**: 合并等于让 optionsdesk 经 marketdata 的函数无痕读表,
 * 护城河探针就再也看不见这条边」。那条判断写于 046 —— 当时 optionsdesk **没有**通往
 * marketdata 的 module 边, 唯一的合法路径就是 catalog Q7-B 的跨 ctx 只读直查, 而它的可见性
 * 全靠访问语句上方那行 `CROSS-CONTEXT-READ`; 一旦把查询搬进 marketdata 的普通函数, 这条边
 * 在 `check-server-moat` 眼里就消失了。
 *
 * **其前提在 061 之后已变**: optionsdesk 有了一条 module 边 (ADR-0062 / 061 T008,
 * `MarketdataModule` 端口注入)。改走端口后这条边并没有隐形, 而是换了个**更强**的形态存在 ——
 * 每个消费 use case 的构造器注入参数上方一行 `// CROSS-CONTEXT-SYNC:`, `check-server-moat`
 * 的 Check 2 硬扫注入点, 缺注释即拒。⇒ 探针照样看得见, 且看见的是 N 个真实消费点而不是一处
 * 中转查询。
 *
 * **为什么现在必须合并**: 062 起「最近一场已收盘交易日」的判据多了一维 —— 收盘上界若落在
 * 覆盖声明之外, 库里那个「≤ 上界的最大交易日」不是真的最近一场, 拿它判陈旧会让档位悄悄错一档
 * (`state_branch` 9)。这份判据当时有**两份**实现 (marketdata 的 `get-instrument-bars.usecase.ts`
 * 与本文件), 两份维护必漂移, 而漂移**不报错**。现在两处同走
 * {@link TradingCalendarPort.lastClosedSession} 的唯一实现。
 *
 * 🚫 **MUST NOT 回退成直查** —— `scripts/checks/check-trading-day-read.ts` (T012) 会拒。
 */

/**
 * 逐市场求「最近一个已收盘交易日」。不可判定 (日历未填充该市场 / 收盘上界落在覆盖声明之外)
 * ⇒ `null`, 由 `freshnessTier` fail-open 成 `CURRENT`。
 *
 * 复杂度 O(m) 次端口调用, m = **去重后**的市场数 (实际 ≤ 3: cn / hk / us)。
 *
 * @param now 注入时钟 (测试可控; 生产取 `new Date()`)。
 */
export async function resolveLastClosedSessions(
  calendar: TradingCalendarPort,
  markets: readonly string[],
  now: Date = new Date(),
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  for (const market of new Set(markets)) {
    out.set(market, await calendar.lastClosedSession(market, now));
  }
  return out;
}

/**
 * 单个锚 ticker (`market:code`) 的「最近一个已收盘交易日」。ticker 不合法 ⇒ `null`
 * (与 `sync-anchor-quote` 对不可解析 ticker 的处置同向: 不猜市场)。
 */
export async function resolveLastClosedSessionForTicker(
  calendar: TradingCalendarPort,
  ticker: string,
  now: Date = new Date(),
): Promise<string | null> {
  const parsed = parseAnchorTicker(ticker);
  if (parsed === null) return null;
  return calendar.lastClosedSession(parsed.market, now);
}

/** 锚 ticker 列表 → 去重后的市场列表 (不可解析的 ticker 直接丢弃)。 */
export function marketsOfTickers(tickers: readonly string[]): string[] {
  const markets = new Set<string>();
  for (const ticker of tickers) {
    const parsed = parseAnchorTicker(ticker);
    if (parsed !== null) markets.add(parsed.market);
  }
  return [...markets];
}
