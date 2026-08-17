import { Injectable } from '@nestjs/common';
import { parseCanonicalSymbol } from './marketdata.rules.js';
import {
  RealtimeQuoteMarketUnsupportedError,
  type RealtimeQuote,
  type RealtimeQuotePort,
} from './realtime-quote.port.js';

/**
 * 按市场路由的实时报价源 (061 T005, FR-010 / FR-018, plan D1/D2)。`REALTIME_QUOTE_PORT` 只有
 * 一个绑定, 而各市场的实时源天然不同 vendor (us 走富途 shim; cn 的现役实时源今天还挂在
 * `alert` 里、且富途账号无 A 股权限) —— 故「不同市场用不同 vendor」这件事必须由一层路由承担。
 *
 * V1 路由 (见 `marketdata.module.ts` 接线):
 * - `us` → 富途 shim `/option-snapshot` 的正股行 (`FutuRealtimeQuoteAdapter`)
 * - `hk` / `cn` → **槽留空** (本片 out of scope; 留空 = 该市场的锚恒为收盘档)
 *
 * 🚨 **无默认路由 = 刻意 fail-closed** (同 `MarketRoutedEodBarAdapter`): 未登记的市场直接抛,
 * 而不是悄悄落到某个 vendor 上 —— 后者会把「配置漏了」表现成「每只标的都失败」。
 *
 * ## 🚨🚨 抛的是**专属错误类型**, 不是裸 `Error`
 *
 * {@link RealtimeQuoteMarketUnsupportedError} 是**配置事实**的载体, 上游 (盘中投影 tick + 熔断)
 * 靠它把「这个市场没接实时源」与「已接的源真调不通」分开计数。判据与后果见该类的注释
 * (一只合法的 hk 锚足以让 90 秒后整条链降级)。
 *
 * ## 校验先于派发: 任一市场无路由 ⇒ **零外呼**
 *
 * 混批里只要有一个未登记市场就整批抛, 不先把 us 那一半发出去 —— 半成半败的返回值会让调用方
 * 既拿到数据又拿到异常, 而 spec 的部分失败语义 (`state_branch` 8) 是**按 market 分组**在调用方
 * 兑现的 (逐组独立 try/catch), 不在这一层。
 *
 * 本类无状态、无 IO。
 */
@Injectable()
export class MarketRoutedRealtimeQuoteAdapter implements RealtimeQuotePort {
  constructor(private readonly routes: Readonly<Record<string, RealtimeQuotePort>>) {}

  /** 复杂度 O(symbol 数) 分组 + 被选实现自身的开销 (每个已登记市场至多 1 次委派)。 */
  async fetchQuotes(symbols: readonly string[]): Promise<Map<string, RealtimeQuote>> {
    if (symbols.length === 0) {
      throw new Error('[realtime-quote] 入参 symbols 为空; 工作集为空时不该调用本端口');
    }

    const byMarket = new Map<string, string[]>();
    for (const symbol of symbols) {
      // 不成形的 symbol 归空串这一组 —— 它必然无路由, 于是走同一条 fail-closed 路径 (不猜市场)。
      const market = parseCanonicalSymbol(symbol)?.market ?? '';
      const group = byMarket.get(market);
      if (group === undefined) byMarket.set(market, [symbol]);
      else group.push(symbol);
    }

    // 先全量校验再派发: 保证「无路由」这条分支恒为零外呼 (上面第三段)。
    for (const market of byMarket.keys()) {
      if (this.routes[market] === undefined) {
        throw new RealtimeQuoteMarketUnsupportedError(market, Object.keys(this.routes));
      }
    }

    const quotes = new Map<string, RealtimeQuote>();
    // 顺序委派而非并发: 今天只有一个已登记市场, 而将来多市场同源时并发只会让同一个 shim
    // 令牌桶在同一瞬间被打两下, 收益为零。
    for (const [market, group] of byMarket) {
      const batch = await this.routes[market].fetchQuotes(group);
      for (const [symbol, quote] of batch) quotes.set(symbol, quote);
    }
    return quotes;
  }
}
