import { Injectable, Logger } from '@nestjs/common';
import type { RealtimeQuotePort } from './realtime-quote.port.js';
import type { RealtimeQuote } from './realtime-quote.rules.js';

/**
 * 024 T007 实时行情 FallbackChain adapter (REALTIME_QUOTE_PORT live 绑定, US1, ADR-0047 范式)。
 *
 * 包裹有序节点 `[primary, ...secondaries]` (V1 = `[腾讯, 新浪]`)。按序尝试:
 *   - 节点抛错 (非 2xx / 超时 / schema drift) → 记 warn, 平移下一节点
 *   - 节点返非空 → 短路返回 (主源命中即停, 不打备源)
 *   - 全部失败 → **抛** (区别于搜索 FallbackChain 返空: 实时全源断须上抛供 T008 Redis
 *     failstreak 熔断计数 + 降级 EOD-only, plan D4)
 *
 * 消费者只依赖 `REALTIME_QUOTE_PORT` Symbol, 不感知双源 / 降级 (ADR-0047)。各源「200 但 0 解析」
 * 由各 adapter 自抛 (schema 校验), 在此与传输故障同等平移。
 */
@Injectable()
export class RealtimeQuoteFallbackChainAdapter implements RealtimeQuotePort {
  private readonly logger = new Logger(RealtimeQuoteFallbackChainAdapter.name);

  constructor(private readonly nodes: RealtimeQuotePort[]) {}

  async fetchQuotes(symbols: readonly string[]): Promise<Map<string, RealtimeQuote>> {
    if (symbols.length === 0) return new Map();
    let lastError: unknown;
    for (let i = 0; i < this.nodes.length; i++) {
      try {
        const quotes = await this.nodes[i].fetchQuotes(symbols);
        if (quotes.size > 0) return quotes;
        // 非抛的空结果 (理论上 adapter 已自抛) → 当失败平移下一节点。
        lastError = new Error(`realtime node #${i} returned empty`);
      } catch (err) {
        lastError = err;
        this.logger.warn(
          `realtime node #${i} failed, falling through: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    throw new Error(
      `all realtime quote sources failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }
}
