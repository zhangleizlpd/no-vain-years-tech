import { Prisma } from '../generated/prisma/client';
import type { FxPair } from './fx-rate.port';

/**
 * 085 T001 FX 解析纯函数 (FR-002 / FR-006; plan D3; ADR-0043 §4 rules 无副作用)。
 *
 * 职责: 把腾讯 `wh` 汇率端点的 GBK 字节响应解析为币对 → 即期汇率。
 * adapter (T002) 请求原始字节 → 调本文件解码 + 解析 → 经 FallbackChain 收敛口径。
 * 无 IO / 无 DI, 复杂度 O(响应长度)。
 *
 * ## 🚫 复用 `alert/realtime-quote.rules.ts`
 *
 * 股票是 88 字段、FX 是 22 字段, 字段下标完全不同; 且 alert 住另一个 bounded context, 跨 ctx
 * import 被 `eslint-plugin-boundaries` 拦 (ADR-0053)。**照写法另落一份**, 两份并存是已知且
 * 已批准的状态 (plan Complexity Tracking)。
 *
 * ## 三条解析契约 (与 alert 那份**刻意相反**的那条在①)
 *
 * 1. **请求 N 对必须回 N 对, 少一对即抛**。alert 侧「部分命中不算失败」是对的 —— 那边少一个
 *    标的只是少一条推送; 这边少一对会让那一屏**悄悄走降级路径**, 而屏幕上一切正常。
 *    EVIDENCE: 部分命中 = 静默省略 —— `whUSDCNY,whZZZZZZ,whUSDHKD` 只回 2 条、无效码那条直接
 *    消失; 全部无效才返哨兵 (plan 作者 2026-09-16 PoC 实拉, plan §plan 前验证「三条原记录被
 *    实测推翻」③)。
 * 2. **哨兵 `v_pv_none_match="1"` 显式挡**。照抄既有股票解析器的正则会把 `pv_none_match` 当成
 *    一个 symbol 解出来、再靠字段数静默跳过 ⇒ 得到「零汇率但不报错」(同上 PoC)。
 * 3. **汇率位不可 `Decimal` 解析 (或非正) 即抛** —— 不回落任何默认值。
 *
 * ## 腾讯 `wh` 字段位 (`fN` = 按 `~` 切开后第 N 段, **0 起数**)
 *
 * 只消费两位, 其余位一律不碰 (vendor 不给字段名, 语义未定是常态):
 * - `f3` = **即期汇率**, 唯一消费的价格位。EVIDENCE: `USDHKD` 与 frankfurter / er-api 三源对拍
 *   吻合 0.002% (plan 作者 2026-09-16 实拉, plan §D3 字段位对照表)。
 * - `f5` = `YYYYMMDDHHmmss`, **vendor 刷新该条记录的时刻**, 只作日志证据 ({@link FxQuote.vendorStamp})。
 *
 * 🚫 **取 `f10` 或 `f11`**: `f10` 稳态恒等于 `f3` 但更新瞬间滞后约 40s (EVIDENCE: `USDHKD`
 * round 7–8 出现 `f3=7.8434` / `f10=7.8448`, 同上实拉); `f11` 语义未定 ⇒ 不消费。
 * 取错位的实现在稳态夹具上**照样绿**, 故 spec 的夹具蓄意让 `f10 ≠ f3`。
 */

/** 解析失败 —— 由 adapter 上抛给 FallbackChain 平移 / 全败上抛 (T002)。 */
export class FxParseError extends Error {
  constructor(message: string) {
    super(`[fx-rate] ${message}`);
    this.name = 'FxParseError';
  }
}

/** 单个币对的解析结果。 */
export interface FxQuote {
  /** 即期汇率 (`Prisma.Decimal`, 不经 Number 中转)。 */
  readonly rate: Prisma.Decimal;
  /**
   * vendor 自报的刷新时刻原文; 该源不给 / 字段位未核实 ⇒ `null`。
   *
   * 🚨 **只作 `EVIDENCE:` 日志证据, 🚫 当作该汇率的时效** —— 上屏时刻一律是我们自己的采集
   * 时刻 (plan D5 / {@link FxRate.capturedAt})。实测 `f5` 可一路推进而 `f3` 纹丝不动, 拿它背书
   * 就是给旧数字盖新时间戳, 而屏幕上一切正常。
   */
  readonly vendorStamp: string | null;
}

/** GBK 字节响应解码为字符串 (Node full-icu 原生 TextDecoder, 无第三方依赖)。 */
export function decodeGbk(raw: Uint8Array): string {
  return new TextDecoder('gbk').decode(raw);
}

/** 腾讯 `v_<sym>="..."` 变量提取 (g 全局; payload 可空)。 */
const TENCENT_VAR = /v_(\w+)="([^"]*)"/g;

/** 全部币对无效时 vendor 返回的哨兵变量名 (`v_pv_none_match="1"`)。 */
const TENCENT_SENTINEL_VAR = 'pv_none_match';
/** 腾讯汇率符号前缀 (`whUSDCNY`)。 */
const TENCENT_SYMBOL_PREFIX = 'wh';

/** 腾讯即期汇率位。 */
const TENCENT_RATE_INDEX = 3;
/** 腾讯 vendor 刷新时刻位 (证据用)。 */
const TENCENT_STAMP_INDEX = 5;

/** 字段数下限 = 消费到的最大下标 + 1。绑在**消费点**上而不是「22 字段」那个观测值: 后者只在
 *  vendor 一字不改时成立, 而多出字段并不影响我们读的两位 (22 字段本身由 T002 的真 vendor 块校)。 */
const TENCENT_MIN_FIELDS = TENCENT_STAMP_INDEX + 1;

/** vendor 符号 (已去前缀) → 币对; 不是本片消费的三对之一 ⇒ `null`。 */
function toFxPair(raw: string, requested: readonly FxPair[]): FxPair | null {
  const upper = raw.toUpperCase();
  return requested.find((pair) => pair === upper) ?? null;
}

/** 汇率位 → `Decimal`; 不可解析 / 非正 / 非有限即抛 (契约③)。非正值还会让取倒数无定义。 */
function toRate(raw: string, where: string): Prisma.Decimal {
  let rate: Prisma.Decimal;
  try {
    rate = new Prisma.Decimal(raw);
  } catch {
    throw new FxParseError(`${where}: 汇率位不可解析 —— ${JSON.stringify(raw)}`);
  }
  if (!rate.isFinite() || rate.lte(0)) {
    throw new FxParseError(`${where}: 汇率位非正或非有限 —— ${rate.toString()}`);
  }
  return rate;
}

/** 契约①: 请求 N 对必须回 N 对。 */
function requireAllPairs(
  quotes: ReadonlyMap<FxPair, FxQuote>,
  requested: readonly FxPair[],
  source: string,
): void {
  const missing = requested.filter((pair) => !quotes.has(pair));
  if (missing.length > 0) {
    throw new FxParseError(
      `${source}: 请求 ${requested.length} 对, 缺 ${missing.join(' / ')} —— 部分命中不算成功`,
    );
  }
}

/**
 * 解析腾讯汇率响应文本 → 币对 → 汇率 (取 `f3`)。
 * @param text GBK 解码后的响应文本 (adapter 用 `parseTencentFx(decodeGbk(bytes), pairs)`)
 */
export function parseTencentFx(
  text: string,
  requestedPairs: readonly FxPair[],
): Map<FxPair, FxQuote> {
  const quotes = new Map<FxPair, FxQuote>();
  for (const match of text.matchAll(TENCENT_VAR)) {
    const symbol = match[1];
    if (symbol === TENCENT_SENTINEL_VAR) {
      // 🚨 无条件挡, 不是「什么都没解出来时的兜底」—— 哨兵与有效行同时出现时也必须抛。
      throw new FxParseError(`腾讯返回哨兵 v_${TENCENT_SENTINEL_VAR} —— 本批币对全部无效, 零汇率`);
    }
    if (!symbol.startsWith(TENCENT_SYMBOL_PREFIX)) continue;
    const pair = toFxPair(symbol.slice(TENCENT_SYMBOL_PREFIX.length), requestedPairs);
    if (pair === null) continue;
    const fields = match[2].split('~');
    if (fields.length < TENCENT_MIN_FIELDS) {
      throw new FxParseError(`腾讯 ${pair}: 字段数 ${fields.length} 不足 —— schema drift?`);
    }
    quotes.set(pair, {
      rate: toRate(fields[TENCENT_RATE_INDEX], `腾讯 ${pair}`),
      vendorStamp: fields[TENCENT_STAMP_INDEX],
    });
  }
  requireAllPairs(quotes, requestedPairs, '腾讯');
  return quotes;
}

/**
 * 反向币对取倒数 (`HKDCNY` → `CNYHKD`)。
 *
 * EVIDENCE: 反向三对 (`whCNYHKD` / `whHKDUSD` / `whCNYUSD`) 全 MISS, 倒数往返误差 < 1e-9
 * (plan 作者 2026-09-16 PoC P3 实拉)。
 */
export function invertRate(rate: Prisma.Decimal): Prisma.Decimal {
  if (!rate.isFinite() || rate.lte(0)) {
    throw new FxParseError(`取倒数要求正的有限汇率 —— ${rate.toString()}`);
  }
  return new Prisma.Decimal(1).div(rate);
}
