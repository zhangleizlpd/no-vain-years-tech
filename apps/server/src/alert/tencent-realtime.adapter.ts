import { Injectable } from '@nestjs/common';
import type { RealtimeQuotePort } from './realtime-quote.port.js';
import type { RealtimeQuote } from './realtime-quote.rules.js';
import { decodeGbk, parseTencentRealtimeQuotes } from './realtime-quote.rules.js';
import { httpFetchBytes, type RealtimeFetch } from './realtime-fetch.js';

/**
 * 024 T007 腾讯实时快照 adapter (**主源**, US1, REALTIME_QUOTE_PORT FallbackChain 首节点)。
 *
 * GET `https://qt.gtimg.cn/q={sym1},{sym2},...` (by-code 批量, PoC 实测 ≥600 只/请求覆盖预警集合,
 * 0.28s)。GBK + `~` 分隔, changePct 直给 (idx32)。无 Referer 要求。
 *
 * 失败语义 (FallbackChain 切新浪的触发): 非 2xx / 超时 → httpFetchBytes 抛; 200 但解析 0 条
 * (schema drift / 参数失效) → 本 adapter 抛 (「schema 校验不过当失败」)。部分命中 (无效码省略)
 * 不算失败。真实字段 / 批量上限 / 延迟由 T012 env-gated IT 校真, 此处仅请求编排 + 解析接线。
 */
@Injectable()
export class TencentRealtimeAdapter implements RealtimeQuotePort {
  constructor(private readonly fetchBytes: RealtimeFetch = httpFetchBytes) {}

  async fetchQuotes(symbols: readonly string[]): Promise<Map<string, RealtimeQuote>> {
    if (symbols.length === 0) return new Map();
    const url = `https://qt.gtimg.cn/q=${symbols.join(',')}`;
    const bytes = await this.fetchBytes(url);
    const quotes = parseTencentRealtimeQuotes(decodeGbk(bytes));
    if (quotes.size === 0) {
      throw new Error('tencent realtime: 0 parsed quotes (schema drift / 全无效码)');
    }
    return quotes;
  }
}
