/**
 * 024 T006 实时行情解析纯函数 (US1; ADR-0043 §4 rules 无副作用)。
 *
 * 职责: 把腾讯/新浪实时快照接口的 GBK 字节响应解析为标的报价 Map (按 vendor 符号对齐)。
 * 双源 adapter (T007) 各自请求原始字节 → 调本文件解码+解析 → 经 FallbackChain 收敛口径。
 * 纯函数: 无 IO / 无 DI, 仅 (bytes|text) → Map, 便于锚真实样本红绿 (PoC §5.1)。
 *
 * 字段下标程序化核实 (2026-06-08 盘后真实请求):
 *   - 腾讯 qt.gtimg.cn: `v_<sym>="<88 字段 ~ 分隔>";`
 *     name[1] / code[2] / price[3] / prevClose[4] / 涨跌额[31] / **changePct[32]** (直给)
 *   - 新浪 hq.sinajs.cn (须 Referer): `var hq_str_<sym>="<33 字段 , 分隔>";`
 *     name[0] / open[1] / prevClose[2] / price[3]; **changePct 自算** (price-prevClose)/prevClose
 *
 * 口径收敛: 两源统一输出 {symbol, name, price, prevClose, changePct(%, 2 位)}。腾讯直给四舍五入
 * 已 2 位; 新浪自算后同样收敛到 2 位 → 与腾讯对拍一致 (样本验平安+0.46/茅台-0.78 两源相等)。
 *
 * 防御 (FR 静默省略, 不抛): 无效码空 payload / 字段不足 / 现价或昨收不可解析 → 跳过该标的,
 * 不影响同响应其它有效标的 (腾讯按 v_ 变量对齐而非请求顺序)。
 */

/** 单标的实时报价 (port 投影 {price,prevClose,changePct} 的超集; name 供推送文案/解码校验)。 */
export interface RealtimeQuote {
  /** vendor 符号 (含市场前缀, e.g. 'sz000001' / 'sh600519'); = 请求 query code, 对齐键。 */
  symbol: string;
  /** 标的名 (GBK 解码; 校验解码正确性 + 推送文案可选用)。 */
  name: string;
  /** 现价 (元)。 */
  price: number;
  /** 昨收 (元)。 */
  prevClose: number;
  /** 当日涨跌幅 (%, 2 位); 腾讯直给 / 新浪自算。 */
  changePct: number;
}

/** 不支持的盘中实时市场 (V1 仅 cn A 股; hk/us 无实时源接入)。 */
export class UnsupportedRealtimeMarketError extends Error {
  constructor(readonly market: string) {
    super(`[realtime-quote] 盘中实时仅支持 cn A 股: market="${market}"`);
    this.name = 'UnsupportedRealtimeMarketError';
  }
}

/**
 * (market, code) → 腾讯/新浪 vendor 符号 (含交易所前缀, e.g. 'sh600519' / 'sz000001' / 'bj920819')。
 * canonical 只到市场粒度 (cn), 交易所由代码首位还原 (镜像 marketdata eastmoney-symbol 思路, 但
 * 腾讯/新浪用 sh/sz/bj 文本前缀且北交所独立 — 不复用东财数字号)。非 cn → 抛 (盘中实时 V1 范围)。
 */
export function toVendorSymbol(market: string, code: string): string {
  if (market !== 'cn') throw new UnsupportedRealtimeMarketError(market);
  return `${cnExchangePrefix(code)}${code}`;
}

/** A 股代码首位 → 交易所前缀 (920 北交所新段须先于 9 沪B 判定)。 */
function cnExchangePrefix(code: string): 'sh' | 'sz' | 'bj' {
  if (code.startsWith('920')) return 'bj'; // 北交所新段 (#920xxx 京市)
  if (code.startsWith('8') || code.startsWith('4')) return 'bj'; // 北交所 (43/83/87/88)
  if (code.startsWith('6') || code.startsWith('9') || code.startsWith('5')) return 'sh'; // 沪主板/科创/沪B/沪基金
  return 'sz'; // 0/3/1/2 深市 (主板/创业板/基金/深B)
}

/** GBK 字节响应解码为字符串 (Node full-icu 原生 TextDecoder, 无第三方依赖)。 */
export function decodeGbk(raw: Uint8Array): string {
  return new TextDecoder('gbk').decode(raw);
}

/** 涨跌幅四舍五入到 2 位 (与腾讯直给口径对齐)。 */
function roundPct(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 腾讯 `v_<sym>="..."` 变量提取 (g 全局; payload 可空)。 */
const TENCENT_VAR = /v_(\w+)="([^"]*)"/g;
/** 新浪 `var hq_str_<sym>="..."` 变量提取。 */
const SINA_VAR = /var hq_str_(\w+)="([^"]*)"/g;

/**
 * 解析腾讯实时快照文本 → 报价 Map (键 = vendor 符号)。changePct 取直给 idx32。
 * @param text GBK 解码后的响应文本 (adapter 用 `parseTencentRealtimeQuotes(decodeGbk(bytes))`)
 */
export function parseTencentRealtimeQuotes(text: string): Map<string, RealtimeQuote> {
  const quotes = new Map<string, RealtimeQuote>();
  for (const match of text.matchAll(TENCENT_VAR)) {
    const symbol = match[1];
    const fields = match[2].split('~');
    // 价格面须到 idx32 (changePct); 不足即无效/异常 → 静默省略
    if (fields.length <= 32) continue;
    const price = Number(fields[3]);
    const prevClose = Number(fields[4]);
    if (!Number.isFinite(price) || !Number.isFinite(prevClose)) continue;
    const direct = Number(fields[32]);
    const changePct = Number.isFinite(direct)
      ? direct
      : prevClose > 0
        ? roundPct(((price - prevClose) / prevClose) * 100)
        : 0;
    quotes.set(symbol, { symbol, name: fields[1], price, prevClose, changePct });
  }
  return quotes;
}

/**
 * 解析新浪实时快照文本 → 报价 Map (键 = vendor 符号)。changePct 自算 (price-prevClose)/prevClose。
 * @param text GBK 解码后的响应文本 (adapter 用 `parseSinaRealtimeQuotes(decodeGbk(bytes))`)
 */
export function parseSinaRealtimeQuotes(text: string): Map<string, RealtimeQuote> {
  const quotes = new Map<string, RealtimeQuote>();
  for (const match of text.matchAll(SINA_VAR)) {
    const symbol = match[1];
    if (match[2] === '') continue; // 无效码 → 空 payload
    const fields = match[2].split(',');
    if (fields.length <= 3) continue;
    const prevClose = Number(fields[2]);
    const price = Number(fields[3]);
    if (!Number.isFinite(price) || !Number.isFinite(prevClose)) continue;
    const changePct = prevClose > 0 ? roundPct(((price - prevClose) / prevClose) * 100) : 0;
    quotes.set(symbol, { symbol, name: fields[0], price, prevClose, changePct });
  }
  return quotes;
}
