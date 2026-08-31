import type { PrismaService } from '../security/prisma.service';
import { parseAnchorTicker } from './anchor.rules';

/**
 * 045 plan D13 —— 雷达 / 锚列表行首「标的标识」里的**标的名**取数侧。
 *
 * D13 定的字段形状是「ticker + 中文名」并作一个字段, 但 T024 实装只落了 `market:code` 的
 * 两半 (代号 + canonical ticker), 名字这一半从头没接上 —— 屏上是 `01024 hk:01024`, 港股代号
 * 人读不出是哪只票。本文件补的就是那一半。
 *
 * 🚨 **跨 ctx 只读直查 (catalog Q7-B)**: 走 `PrismaService` 直查 `marketdata.instrument`,
 * **禁 `@Inject()` marketdata 的 use case** (Q7-C), 读法与 `sync-anchor-quote.ts` 的
 * instrument 寻址逐字同形。`// CROSS-CONTEXT-READ:` 注释必须挂在 **prisma 调用语句正上方**
 * —— `scripts/checks/check-server-moat.ts` 的 AST 探针只认那一处 (挂 import 上方不被采信)。
 *
 * 🚫 **单向**: 名字的唯一真相源是 `marketdata.instrument.name` (universe 同步维护), 本 ctx
 * 零写、也 MUST NOT 把它投影进锚表 —— 锚表投影 `last_close` 是为了让距 W% 成为同表可排序
 * 表达式 (plan D4 的唯一理由), 名字既不参与排序也不参与筛选, 落列只会多一份会漂的副本。
 *
 * 降级纪律: 未注册 instrument / ticker 不可解析 ⇒ `null`, 由呈现层退回代号。**MUST NOT** 拿
 * ticker 拼一个假名字 —— 那会让「名字没同步上」和「这票就叫这个」在屏上分不开。
 *
 * ⚠️ `name` 等于 code 的行是 `sync-universe.usecase.ts` 的**占位**(该票已入库、universe 还没
 * 轮到它填真名)。这里**不特判**: 原样交出去正好退化成本片之前的呈现 (代号), 特判成 `null`
 * 结果一模一样, 却多一条要维护的判据。
 */

/**
 * 批量: 锚 ticker 列表 → `market:code` ⇒ 标的名。未注册的票**不进** map (调用方退回代号)。
 *
 * 复杂度: 一次 `findMany`, O(1) 往返 / O(n) 内存, n = 去重后的 ticker 数。分页读端每页只调
 * 一次 —— 逐行点查会在 50 行的雷达页上放大成 50 次往返。
 *
 * 🚨 谓词**按市场分组**成 `(market = ? AND code IN (…))`, 不是 n 个 `(market, code)` 对或起来:
 * 锚表上限约 1000 行 (spec Assumptions) ⇒ 后者会生成上千个 OR 子句, 而分组后恒 ≤ 市场数
 * (实际 ≤ 3), 正好落在 `market_code` 唯一索引上。分组不会跨市场串味 —— 每个市场的 code 集合
 * 只装该市场自己见过的 code。
 */
export async function resolveInstrumentNames(
  prisma: PrismaService,
  tickers: readonly string[],
): Promise<Map<string, string>> {
  const codesByMarket = new Map<string, Set<string>>();
  for (const ticker of tickers) {
    const parsed = parseAnchorTicker(ticker);
    if (parsed === null) continue;
    const codes = codesByMarket.get(parsed.market);
    if (codes === undefined) codesByMarket.set(parsed.market, new Set([parsed.code]));
    else codes.add(parsed.code);
  }
  if (codesByMarket.size === 0) return new Map();

  // CROSS-CONTEXT-READ: marketdata.instrument 只读直查 (catalog Q7-B) —— 锚 ticker → 标的名。
  // 零写、零 @Inject() 对方 use case (Q7-C); marketdata 不知道锚表存在 (方向铁律)。
  const rows = await prisma.instrument.findMany({
    where: {
      OR: [...codesByMarket].map(([market, codes]) => ({ market, code: { in: [...codes] } })),
    },
    select: { market: true, code: true, name: true },
  });
  return new Map(rows.map((row) => [`${row.market}:${row.code}`, row.name]));
}

/**
 * 单只锚 ticker → 标的名; ticker 不可解析 / 未注册 ⇒ `null` (与
 * `resolveLastClosedSessionForTicker` 对不可解析 ticker 的处置同向: 不猜)。
 */
export async function resolveInstrumentName(
  prisma: PrismaService,
  ticker: string,
): Promise<string | null> {
  const parsed = parseAnchorTicker(ticker);
  if (parsed === null) return null;

  // CROSS-CONTEXT-READ: marketdata.instrument 只读直查 (catalog Q7-B) —— 锚 ticker → 标的名。
  const row = await prisma.instrument.findUnique({
    where: { market_code: { market: parsed.market, code: parsed.code } },
    select: { name: true },
  });
  return row?.name ?? null;
}
