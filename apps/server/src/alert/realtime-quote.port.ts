import type { RealtimeQuote } from './realtime-quote.rules.js';

/**
 * 024 T007 实时行情端口 (US1; alert ctx 自持外部 IO, plan D2 — 叶子 ctx 不 import marketdata,
 * 镜像 021「alert 自持 queue」先例)。消费者 (T009 evaluate-intraday UC) 仅依赖此 Symbol +
 * interface, 不感知腾讯主 / 新浪备双源 + FallbackChain 编排 (ADR-0047 范式)。
 */
export const REALTIME_QUOTE_PORT = Symbol('REALTIME_QUOTE_PORT');

export interface RealtimeQuotePort {
  /**
   * 批量取实时报价。键 = vendor 符号 (含市场前缀, e.g. 'sz000001')。
   * 无效 / 缺标的静默省略 (非 error, 对齐 vendor「无效码省略」)。
   * 源故障 / 全空 (schema drift) → **抛** (供 T008 Redis failstreak 熔断计数, plan D4)。
   * @param symbols 预警集合派生的拉取符号 (T009 按 intradayEligible 去重, plan D5)
   */
  fetchQuotes(symbols: readonly string[]): Promise<Map<string, RealtimeQuote>>;
}
