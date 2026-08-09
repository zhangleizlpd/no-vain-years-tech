import { describe, it, expect } from 'vitest';
import { TencentRealtimeAdapter } from '../../src/alert/tencent-realtime.adapter';
import { SinaRealtimeAdapter } from '../../src/alert/sina-realtime.adapter';
import { RealtimeQuoteFallbackChainAdapter } from '../../src/alert/realtime-quote-fallback-chain.adapter';
import { REALTIME_FETCH_TIMEOUT_MS } from '../../src/alert/realtime-fetch';
import type { RealtimeQuote } from '../../src/alert/realtime-quote.rules';

/**
 * 024 T012 腾讯/新浪实时源真 vendor IT (env-gated, 默认 skip) — 校真 mock 单测覆盖不到的 vendor 契约。
 *
 * 目的: 用真实网络打腾讯 qt.gtimg.cn / 新浪 hq.sinajs.cn, 证实 T006 解析纯函数锚定的 PoC 字段下标
 * (腾讯 `~` idx3/4/32 / 新浪 `,` idx0/2/3 + Referer) 在当前线上响应仍成立 —— 字段·批量·延迟·双源切换
 * 四面校真。vendor schema drift / Referer 策略变更在此被证实或证伪 (错则按真实响应修 realtime-quote.rules)。
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

/** 单标的报价字段齐全 + 合理值域断言 (两源共用)。 */
function expectValidQuote(q: RealtimeQuote | undefined, symbol: string): void {
  expect(q, `${symbol} 应有报价`).toBeDefined();
  if (q === undefined) return;
  expect(q.symbol).toBe(symbol);
  expect(q.name.length).toBeGreaterThan(0); // GBK 解码出中文名
  expect(q.price).toBeGreaterThan(0);
  expect(q.prevClose).toBeGreaterThan(0);
  expect(Number.isFinite(q.changePct)).toBe(true);
}

describe.skipIf(!RUN)('024 腾讯/新浪实时源真 vendor IT (env-gated, 默认 skip)', () => {
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

  it('新浪备源: 必带 Referer → 批量全返 + 字段齐全 (changePct 自算)', async () => {
    const adapter = new SinaRealtimeAdapter();
    const quotes = await adapter.fetchQuotes(SYMBOLS);

    expect(quotes.size).toBe(SYMBOLS.length);
    for (const s of SYMBOLS) expectValidQuote(quotes.get(s), s);
  });

  it('双源对拍: 同标的昨收严格相等 + 现价同口径 (盘后相等/盘中容差 1%)', async () => {
    const [tencent, sina] = await Promise.all([
      new TencentRealtimeAdapter().fetchQuotes(SYMBOLS),
      new SinaRealtimeAdapter().fetchQuotes(SYMBOLS),
    ]);
    for (const s of SYMBOLS) {
      const t = tencent.get(s)!;
      const n = sina.get(s)!;
      // 昨收两源同一基准 → 应严格相等 (浮点 2 位容差)
      expect(Math.abs(t.prevClose - n.prevClose)).toBeLessThan(0.01);
      // 现价: 盘后两源相等; 盘中可能差 1 个 tick → 1% 容差
      expect(Math.abs(t.price - n.price) / t.price).toBeLessThan(0.01);
    }
  });

  it('FallbackChain: 腾讯主源命中 → 短路返回 (双源编排活路径)', async () => {
    const chain = new RealtimeQuoteFallbackChainAdapter([
      new TencentRealtimeAdapter(),
      new SinaRealtimeAdapter(),
    ]);
    const quotes = await chain.fetchQuotes(SYMBOLS);
    expect(quotes.size).toBe(SYMBOLS.length);
    for (const s of SYMBOLS) expectValidQuote(quotes.get(s), s);
  });

  it('双源切换: 主源故障 (注入坏 fetch) → 真实切新浪备源兜住', async () => {
    const badPrimary = new TencentRealtimeAdapter(async () => {
      throw new Error('injected primary failure');
    });
    const chain = new RealtimeQuoteFallbackChainAdapter([badPrimary, new SinaRealtimeAdapter()]);
    const quotes = await chain.fetchQuotes(SYMBOLS);
    expect(quotes.size).toBe(SYMBOLS.length); // 新浪真源接管
    for (const s of SYMBOLS) expectValidQuote(quotes.get(s), s);
  });
});
