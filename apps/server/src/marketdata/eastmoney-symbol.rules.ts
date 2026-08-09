/**
 * 东方财富符号归一化纯函数 (015 T012, FR-S10 / US2)。
 *
 * canonical `${market}:${code}` (如 `cn:600519`) ↔ 东财 secid `${mktNum}.${code}`
 * (如 `1.600519`)。东财用 `MktNum` (市场号) 区分交易所:
 *   1 = 上交所(SH) / 0 = 深交所(SZ)+北交所(BJ) / 116 = 港股 / 105·106·107 = 美股。
 * canonical 只到市场粒度 (cn/hk/us) 不分交易所 → SH/SZ 信息在 `toSecid` 时由代码首位
 * 还原 (6 开头=SH, 否则 SZ; 北交所 8/4 开头亦走 SZ 号 0)。
 *
 * 双向无损 (round-trip): `toCanonical(toSecid(c)) === c` (canonical 粒度守恒;
 * secid 的交易所号经代码首位重建)。未知市场号/前缀 **明确抛错**, 不静默错配 (FR-S10 /
 * spec edge「未知市场前缀」)。
 *
 * 注: 东财 searchapi (suggest/get) 解析侧直接消费响应里的 `MktNum`+`Code` → `fromMktNum`;
 * `toSecid` 供未来按 secid 拉行情 (push2) 复用 (015 报价走 EOD-backed 不打东财, 暂未用,
 * 但 round-trip 守恒由测试守护)。真东财字段值由 env-gated IT 校真 (SC-S08)。
 */

/** canonical 支持市场 (东财覆盖 A/HK/US)。 */
export type EastmoneyMarket = 'cn' | 'hk' | 'us';

const SUPPORTED_MARKETS: ReadonlySet<string> = new Set<EastmoneyMarket>(['cn', 'hk', 'us']);

/** 东财 MktNum → canonical 市场 (解析响应用)。 */
const MKT_NUM_TO_MARKET: ReadonlyMap<string, EastmoneyMarket> = new Map([
  ['1', 'cn'], // 上交所
  ['0', 'cn'], // 深交所 + 北交所
  ['116', 'hk'], // 港股
  ['105', 'us'], // 美股 NASDAQ
  ['106', 'us'], // 美股 NYSE
  ['107', 'us'], // 美股 AMEX
]);

/** 未知/不支持市场 → 明确拒绝 (不静默错配)。 */
export class UnsupportedEastmoneyMarketError extends Error {
  constructor(readonly market: string) {
    super(`[eastmoney] unsupported market: "${market}" (支持 cn/hk/us)`);
    this.name = 'UnsupportedEastmoneyMarketError';
  }
}

/** 东财 MktNum + Code → canonical `market:code` (searchapi 响应解析)。未知 MktNum 抛错。 */
export function fromMktNum(mktNum: string | number, code: string): string {
  const market = MKT_NUM_TO_MARKET.get(String(mktNum));
  if (!market) throw new UnsupportedEastmoneyMarketError(`MktNum=${mktNum}`);
  return `${market}:${code}`;
}

/** canonical `market:code` → 东财 secid `mktNum.code`。非 cn/hk/us 抛错。 */
export function toSecid(canonical: string): string {
  const idx = canonical.indexOf(':');
  if (idx <= 0 || idx === canonical.length - 1) {
    throw new UnsupportedEastmoneyMarketError(canonical);
  }
  const market = canonical.slice(0, idx);
  const code = canonical.slice(idx + 1);
  if (!SUPPORTED_MARKETS.has(market)) throw new UnsupportedEastmoneyMarketError(market);

  switch (market) {
    case 'cn':
      // 6 开头 = 上交所(1); 0/3(主板创业板)/4/8(北交所) = 深市号(0)。
      return `${code.startsWith('6') ? '1' : '0'}.${code}`;
    case 'hk':
      return `116.${code}`;
    case 'us':
      return `105.${code}`;
  }
  throw new UnsupportedEastmoneyMarketError(market);
}

/** 东财 secid `mktNum.code` → canonical `market:code`。未知市场号抛错 (round-trip 守恒)。 */
export function toCanonical(secid: string): string {
  const idx = secid.indexOf('.');
  if (idx <= 0 || idx === secid.length - 1) {
    throw new UnsupportedEastmoneyMarketError(secid);
  }
  return fromMktNum(secid.slice(0, idx), secid.slice(idx + 1));
}
