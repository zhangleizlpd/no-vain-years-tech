import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../security/redis.token.js';
import { QUOTE_PORT, type QuotePort } from './quote.port.js';
import type { QuoteSnapshot } from './marketdata.types.js';

/**
 * 批量报价 use case (015 T007, US4, intra query — ADR-0043 直注端口无 repository)。
 *
 * 读路径 **Redis 热快照优先 → miss 回端口 (EOD-backed → PG)** (FR-S07):
 *  1. `quote:{symbol}` MGET 批量命中, 命中项直接复用 (不重打底层)。
 *  2. miss 集合一次性过 QUOTE_PORT 取最新投影, 回写 Redis。
 *  3. 按入参顺序 (含重复) 还原结果 — 自选列表逐行消费稳定。
 *
 * TTL = 至下次 EOD 数据落定 (≈次日 18:00 CST), 各 key **独立 jitter ±10%** 防缓存惊群
 * (cache stampede): 同批 key 不在同一秒集体过期。no-data 项亦缓存 (避免未知 symbol 反复
 * 回源 PG)。priceKind 翻 realtime 时 (实时源接入) TTL 策略另议, 当前纯 EOD 口径。
 */

const KEY = (symbol: string): string => `quote:${symbol}`;

/** 至下次 EOD 数据落定的基准 TTL(秒): 取下一个 10:00 UTC (≈18:00 CST 盘后)。 */
function baseTtlSeconds(now: Date): number {
  const SETTLE_UTC_HOUR = 10;
  const next = new Date(now);
  next.setUTCHours(SETTLE_UTC_HOUR, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next.getTime() - now.getTime()) / 1000));
}

/** 基准 TTL 上叠 ±10% 抖动 (防同批集体过期)。 */
function jitteredTtl(base: number): number {
  return Math.max(1, Math.round(base * (0.9 + Math.random() * 0.2)));
}

@Injectable()
export class GetQuotesUseCase {
  constructor(
    @Inject(QUOTE_PORT) private readonly quotePort: QuotePort,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async execute(symbols: string[]): Promise<QuoteSnapshot[]> {
    const unique = [...new Set(symbols)];
    if (unique.length === 0) return [];

    const resolved = new Map<string, QuoteSnapshot>();
    const cachedRaw = await this.redis.mget(...unique.map(KEY));
    cachedRaw.forEach((raw, i) => {
      if (raw === null) return;
      // 部署过渡兼容: 加 name 前写入的旧快照无 name 键 → 兜 null (契约 name 必现, TTL 内自愈)。
      const parsed = JSON.parse(raw) as QuoteSnapshot;
      resolved.set(unique[i], { ...parsed, name: parsed.name ?? null });
    });

    const misses = unique.filter((s) => !resolved.has(s));
    if (misses.length > 0) {
      const fresh = await this.quotePort.getQuotes(misses);
      for (const quote of fresh) resolved.set(quote.symbol, quote);
      await this.writeCache(fresh);
    }

    // 按入参顺序还原 (含重复行); resolved 必含全部 unique (miss 已回填), 缺失即不变量被破坏。
    return symbols.map((s) => {
      const quote = resolved.get(s);
      if (quote === undefined) throw new Error(`[marketdata] quote missing after backfill: ${s}`);
      return quote;
    });
  }

  private async writeCache(quotes: QuoteSnapshot[]): Promise<void> {
    const base = baseTtlSeconds(new Date());
    await Promise.all(
      quotes.map((quote) =>
        this.redis.set(KEY(quote.symbol), JSON.stringify(quote), 'EX', jitteredTtl(base)),
      ),
    );
  }
}
