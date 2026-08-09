import { Injectable } from '@nestjs/common';
import type { RealtimeQuotePort } from './realtime-quote.port.js';
import type { RealtimeQuote } from './realtime-quote.rules.js';
import { decodeGbk, parseSinaRealtimeQuotes } from './realtime-quote.rules.js';
import { httpFetchBytes, type RealtimeFetch } from './realtime-fetch.js';

/** 新浪实时源必注入此 Referer (PoC 实测: 不带 → 403, 带 → 200)。 */
export const SINA_REFERER = 'https://finance.sina.com.cn';

/**
 * 024 T007 新浪实时快照 adapter (**备源**, US1, REALTIME_QUOTE_PORT FallbackChain 次节点)。
 *
 * GET `https://hq.sinajs.cn/list={sym1},{sym2},...`, **必带 `Referer: finance.sina.com.cn`**
 * (PoC: 不带 403)。GBK + `,` 分隔, changePct 自算 (price-prevClose)/prevClose, 与腾讯对拍一致。
 *
 * 失败语义同腾讯: 非 2xx (含 403 漏 Referer) / 超时 → 抛; 200 但解析 0 条 → 抛。均失败由
 * FallbackChain 上抛供 T008 熔断。真实校真 T012。
 */
@Injectable()
export class SinaRealtimeAdapter implements RealtimeQuotePort {
  constructor(private readonly fetchBytes: RealtimeFetch = httpFetchBytes) {}

  async fetchQuotes(symbols: readonly string[]): Promise<Map<string, RealtimeQuote>> {
    if (symbols.length === 0) return new Map();
    const url = `https://hq.sinajs.cn/list=${symbols.join(',')}`;
    const bytes = await this.fetchBytes(url, { Referer: SINA_REFERER });
    const quotes = parseSinaRealtimeQuotes(decodeGbk(bytes));
    if (quotes.size === 0) {
      throw new Error('sina realtime: 0 parsed quotes (schema drift / 全无效码)');
    }
    return quotes;
  }
}
