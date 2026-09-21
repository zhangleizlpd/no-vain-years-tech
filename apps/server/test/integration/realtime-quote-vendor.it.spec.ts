import { describe, it, expect } from 'vitest';
import { TencentRealtimeAdapter } from '../../src/alert/tencent-realtime.adapter';
import { RealtimeQuoteFallbackChainAdapter } from '../../src/alert/realtime-quote-fallback-chain.adapter';
import { REALTIME_FETCH_TIMEOUT_MS } from '../../src/alert/realtime-fetch';
import type { RealtimeQuote } from '../../src/alert/realtime-quote.rules';

/**
 * 024 T012 腾讯实时源真 vendor IT (env-gated, 默认 skip) — 校真 mock 单测覆盖不到的 vendor 契约。
 *
 * 目的: 用真实网络打腾讯 qt.gtimg.cn, 证实 T006 解析纯函数锚定的 PoC 字段下标 (`~` idx3/4/32)
 * 在当前线上响应仍成立 —— 字段·批量·延迟三面校真。vendor schema drift 在此被证实或证伪
 * (错则按真实响应修 realtime-quote.rules)。
 *
 * 原新浪备源的三个臂 (备源批量 / 双源对拍 / 双源切换) 随备源移除一并删去 (#482) —— 备源在 prod
 * 出口恒超时, 留着只会让这个门控套件在启用时必红。链的「全败抛」编排语义由 Small 档
 * `src/alert/realtime-quote.adapter.spec.ts` 覆盖, 不在 vendor 档重复。
 *
 * **默认 skip** (env-gated, per memory env_gated_perf_it_pattern, 沿 RUN_PERF_IT 范式): 会真打外网
 * (国内域名), CI / 常规 `nx affected` 不跑。纯 adapter 级 (无 PG / 无 Nest boot / 无 Testcontainers)。
 *
 * **本地启用**:
 *   RUN_PERF_IT=1 pnpm nx test server -- realtime-quote-vendor.it
 *
 * 注: 盘后运行返末次收盘快照 (price=close, prevClose 昨收), 字段值域断言仍成立 (不依赖盘中时段)。
 */
const RUN = process.env.RUN_PERF_IT === '1' || process.env.RUN_PERF_IT === 'true';

// 批量请求 3 只活跃标的 (沪主板 / 深主板 / 沪主板; 覆盖 sh/sz 前缀派生)。
const SYMBOLS = ['sh600519', 'sz000001', 'sh601318']; // 贵州茅台 / 平安银行 / 中国平安

/** 单标的报价字段齐全 + 合理值域断言。 */
function expectValidQuote(q: RealtimeQuote | undefined, symbol: string): void {
  expect(q, `${symbol} 应有报价`).toBeDefined();
  if (q === undefined) return;
  expect(q.symbol).toBe(symbol);
  expect(q.name.length).toBeGreaterThan(0); // GBK 解码出中文名
  expect(q.price).toBeGreaterThan(0);
  expect(q.prevClose).toBeGreaterThan(0);
  expect(Number.isFinite(q.changePct)).toBe(true);
}

describe.skipIf(!RUN)('024 腾讯实时源真 vendor IT (env-gated, 默认 skip)', () => {
  it('腾讯主源: 批量请求全返 + 字段齐全 + 延迟 < 超时阈', async () => {
    const adapter = new TencentRealtimeAdapter();
    const start = performance.now();
    const quotes = await adapter.fetchQuotes(SYMBOLS);
    const elapsed = performance.now() - start;

    expect(quotes.size).toBe(SYMBOLS.length); // 批量全返 (无效码省略不应发生于活跃标的)
    for (const s of SYMBOLS) expectValidQuote(quotes.get(s), s);
    expect(elapsed).toBeLessThan(REALTIME_FETCH_TIMEOUT_MS);
    // eslint-disable-next-line no-console
    console.log(`[T012] 腾讯批量 ${SYMBOLS.length} 只 ${elapsed.toFixed(0)}ms`);
  });

  it('FallbackChain: 腾讯单节点命中 → 返回 (链编排活路径)', async () => {
    const chain = new RealtimeQuoteFallbackChainAdapter([new TencentRealtimeAdapter()]);
    const quotes = await chain.fetchQuotes(SYMBOLS);
    expect(quotes.size).toBe(SYMBOLS.length);
    for (const s of SYMBOLS) expectValidQuote(quotes.get(s), s);
  });
});
