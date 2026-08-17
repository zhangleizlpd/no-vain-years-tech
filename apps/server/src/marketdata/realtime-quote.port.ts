/**
 * 实时报价端口 (061 T003, FR-001 / FR-020, plan D2)。**capability-scoped** —— 一个端口 =
 * 一种能力: 「这批标的此刻的最新成交价」这件事, 换成别的行情源也是同一份接口, 只换 adapter。
 *
 * ## 🚨 与 `alert/realtime-quote.port.ts` **同名但不是同一个**, 且不要去统一它们
 *
 * 那个 port 的键是 **vendor 符号** (`'sz000001'` / `'sh600519'`, 转换在
 * `alert/realtime-quote.rules.ts` 的 `toVendorSymbol`) —— 腾讯 / 新浪的 cn 专用形态, 不是通用
 * 契约。本 port 的键是 **canonical `market:code`**, vendor 方言下沉到各 adapter 内部。
 *
 * **同名是刻意的**: 它是**终态名字** —— 后续 feature 把 alert 的实时源收编过来之后那个文件会
 * 删掉, 届时全仓只剩这一个。起第二个名字会让「哪个是终态」在半年后不可读。同名也不会静默
 * 出错: `Symbol('X')` 每次调用产生**不同**的 token 对象, DI 不会串; 单文件同时 import 两个是
 * **编译期**标识符冲突, 不是运行期错乱。
 *
 * ⚠️ 收编是后续 feature 的事 (且被账号权限挡着: 富途无 A 股权限), 本片 `apps/server/src/alert/`
 * 整目录**一行不动** (FR-018)。
 *
 * ## 缺标的静默省略, 源故障 / 全空**抛**
 *
 * 见 {@link RealtimeQuotePort.fetchQuotes}。两者的分界是「这一拍到底采到没有」——
 * 上游 (盘中投影 tick) 对前者保留旧值、对后者计入熔断失败计数, 混成一个返回值会让一条真故障
 * 表现成「今天所有锚都恰好没有报价」。
 *
 * ## 金融数值跨边界一律 `string` (FR-S08 全 marketdata 惯例)
 *
 * 落库列是 `Decimal`, 中途走一趟 JS `number` 就把精度丢在半路。`Decimal` 转换留给写库那一层。
 */

/** DI token。 */
export const REALTIME_QUOTE_PORT = Symbol('REALTIME_QUOTE_PORT');

/**
 * 单批 symbol 上限 (shim `SNAPSHOT_MAX_CODES` 同值 —— 本能力打的就是 `/option-snapshot`)。
 *
 * 🚨 **切批是调用方的事, adapter 只做前置拒绝** (Guardrail 17, 照
 * `option-snapshot.port.ts` 的同源成例): 超限 adapter **零外呼**直接抛, 让 shim 去返 400 也对,
 * 但那要先烧掉一次限频配额。调用方按本常量切批、逐批独立成败 —— 同一段边界逻辑写两遍必漂移。
 */
export const REALTIME_QUOTE_MAX_SYMBOLS = 400;

/** 一个标的此刻的报价。 */
export interface RealtimeQuote {
  /** 最新成交价, Decimal-safe `string` (见文件头)。 */
  price: string;
  /**
   * 本批的**采集墙钟** (source 信封自报的 `as_of`)。
   *
   * 🚨 **MUST NOT 用 vendor 行内的 `update_time` 顶替** —— 那是**最后成交时刻**不是报价时刻,
   * 实测盘中滞后中位 40 s / p95 292 s / max 672 s (p3b E33)。按它判新鲜度会把活跃标的稳定
   * 误判成陈旧, 而这个错**不会红**: 界面只是悄悄回落收盘档。
   *
   * 🚨 也 **MUST NOT 用本机时钟顶替** —— 那会把「这一行是什么时候采的」换成「这段代码什么
   * 时候跑到这一句」, 两者在链路卡顿时差得很远。信封没有可解析的 `as_of` ⇒ adapter 抛。
   */
  capturedAt: Date;
}

export interface RealtimeQuotePort {
  /**
   * 批量取实时报价。键 = canonical `market:code` (**原样回传入参的那个串**, vendor 方言不外泄)。
   *
   * - **缺标的静默省略** (非 error, 对齐既有 vendor 语义): 停牌 / 刚摘牌 / 该标的这一刻没有
   *   成交价都归此列。上游据此**保留旧值**, MUST NOT 写 null 或 0 (spec `state_branch` 7)。
   * - **源故障 / 一条都没采到 → 抛** (供上游 failstreak 熔断计数, spec `state_branch` 4 / 9)。
   * - 入参为空 / 超 {@link REALTIME_QUOTE_MAX_SYMBOLS} → **前置拒绝、零外呼**。
   *
   * @param symbols canonical `market:code` 列表; 切批由调用方按 {@link REALTIME_QUOTE_MAX_SYMBOLS} 做
   */
  fetchQuotes(symbols: readonly string[]): Promise<Map<string, RealtimeQuote>>;
}
