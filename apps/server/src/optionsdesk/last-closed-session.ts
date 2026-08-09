import { lastClosedSessionCutoff } from '../marketdata/trading-day-gate';
import type { PrismaService } from '../security/prisma.service';
import { parseAnchorTicker } from './anchor.rules';

/**
 * 046 FR-020 —— 「最近一个已收盘交易日」的取数侧 (判据本身在 `freshness.rules.ts`)。
 *
 * 🚨 **跨 ctx 只读直查 (catalog Q7-B)**: 走 `PrismaService` 直查 marketdata 的 `trading_day`,
 * 零写、**禁 `@Inject()` marketdata 的 use case** (Q7-C)。`// CROSS-CONTEXT-READ:` 注释挂在
 * 访问语句上方 —— `check-server-moat` 硬扫, 缺注释即拒。体例同 `sync-anchor-quote.ts`。
 *
 * 时区/收盘时刻的换算复用 marketdata 的 `lastClosedSessionCutoff` (纯函数编译期复用, 不撞
 * boundaries 围栏: optionsdesk 的 disallow 只列了 `marketdata-rules`, 该函数不在 `*.rules.ts`)。
 */

/** `@db.Date` 列 → `YYYY-MM-DD` (该类列读出来本就是 UTC 午夜)。 */
function toYmd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * 逐市场求「最近一个已收盘交易日」。查不到 (日历未填充该市场 / 该区间) ⇒ `null`,
 * 由 `freshnessTier` fail-open 成 `CURRENT`。
 *
 * 复杂度 O(m) 次单行索引查询, m = **去重后**的市场数 (实际 ≤ 3: cn / hk / us)。
 *
 * @param now 注入时钟 (测试可控; 生产取 `new Date()`)。
 */
export async function resolveLastClosedSessions(
  prisma: PrismaService,
  markets: readonly string[],
  now: Date = new Date(),
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  for (const market of new Set(markets)) {
    const cutoff = lastClosedSessionCutoff(market, now);
    // CROSS-CONTEXT-READ: marketdata.trading_day 只读直查 (catalog Q7-B) —— 取 ≤ 收盘上界的
    // 最大交易日。零写; marketdata 不知道锚表存在 (方向铁律)。
    const row = await prisma.tradingDay.findFirst({
      where: { market, date: { lte: new Date(`${cutoff}T00:00:00.000Z`) } },
      orderBy: { date: 'desc' },
      select: { date: true },
    });
    out.set(market, row === null ? null : toYmd(row.date));
  }
  return out;
}

/**
 * 单个锚 ticker (`market:code`) 的「最近一个已收盘交易日」。ticker 不合法 ⇒ `null`
 * (与 `sync-anchor-quote` 对不可解析 ticker 的处置同向: 不猜市场)。
 */
export async function resolveLastClosedSessionForTicker(
  prisma: PrismaService,
  ticker: string,
  now: Date = new Date(),
): Promise<string | null> {
  const parsed = parseAnchorTicker(ticker);
  if (parsed === null) return null;
  return (await resolveLastClosedSessions(prisma, [parsed.market], now)).get(parsed.market) ?? null;
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
