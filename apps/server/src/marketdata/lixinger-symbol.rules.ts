/**
 * 理杏仁符号归一化纯函数 (015 T006, FR-S10 / US3)。
 *
 * canonical `${market}:${code}` (如 `cn:600519`) ↔ 理杏仁请求字段。理杏仁 API 按市场
 * 分路径 (`/cn/...` / `/hk/...`) + body 内 `stockCode`(单只) / `stockCodes`(批量) 承载
 * 6 位代码 (验证: Chaoyingz/lixinger Python SDK + lixingr2 R 包 endpoint 注册表)。
 *
 * 双向无损 (round-trip): `toCanonical(toLixinger(c)) === c`。未知市场前缀 (非 cn/hk)
 * **明确抛错**, 不静默错配 vendor symbol (FR-S10 / spec edge「未知市场前缀」)。
 *
 * V1 事实集中 A 股 (cn); 港股 (hk) 路径成立但 fundamental 深度待 016 验 (spec L250)。
 * 美股理杏仁仅 index 无个股 → 不在支持集 (master F1)。
 */

/** 理杏仁支持的市场段 (路径前缀)。 */
export type LixingerMarket = 'cn' | 'hk';

const SUPPORTED_MARKETS: ReadonlySet<string> = new Set<LixingerMarket>(['cn', 'hk']);

/** 理杏仁请求坐标: 市场段 (路径) + 6 位代码 (body)。 */
export interface LixingerSymbol {
  market: LixingerMarket;
  stockCode: string;
}

/** 未知/不支持市场前缀 → 明确拒绝 (不静默错配)。 */
export class UnsupportedLixingerMarketError extends Error {
  constructor(readonly market: string) {
    super(`[lixinger] unsupported market prefix: "${market}" (支持 cn/hk)`);
    this.name = 'UnsupportedLixingerMarketError';
  }
}

function assertSupported(market: string): asserts market is LixingerMarket {
  if (!SUPPORTED_MARKETS.has(market)) throw new UnsupportedLixingerMarketError(market);
}

/** canonical `market:code` → 理杏仁坐标。非 cn/hk 抛 `UnsupportedLixingerMarketError`。 */
export function toLixinger(canonical: string): LixingerSymbol {
  const idx = canonical.indexOf(':');
  if (idx <= 0 || idx === canonical.length - 1) {
    throw new UnsupportedLixingerMarketError(canonical);
  }
  const market = canonical.slice(0, idx);
  const stockCode = canonical.slice(idx + 1);
  assertSupported(market);
  return { market, stockCode };
}

/** 理杏仁坐标 → canonical `market:code`。市场段非 cn/hk 抛错 (round-trip 守恒)。 */
export function toCanonical(symbol: LixingerSymbol): string {
  assertSupported(symbol.market);
  return `${symbol.market}:${symbol.stockCode}`;
}

/**
 * canonical 符号列表按 market 段分组 (038 seam#1): fundamental/fs 批量端点按 `/{market}/...`
 * 路由前先分组 —— 返 `market → (stockCode → canonicalSymbol)`。非 cn/hk 前缀 `toLixinger`
 * 抛 `UnsupportedLixingerMarketError` (不静默错配)。
 */
export function groupByMarket(symbols: string[]): Map<string, Map<string, string>> {
  const byMarket = new Map<string, Map<string, string>>();
  for (const symbol of symbols) {
    const { market, stockCode } = toLixinger(symbol);
    const codeToSymbol = byMarket.get(market) ?? new Map<string, string>();
    codeToSymbol.set(stockCode, symbol);
    byMarket.set(market, codeToSymbol);
  }
  return byMarket;
}
